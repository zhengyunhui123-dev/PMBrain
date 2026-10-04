import type { BrainEngine, ReservedConnection } from '../../core/engine.ts';
import type { Page, PageFilters } from '../../core/types.ts';
import { taskModelFingerprint } from './checkpoint.ts';
import type { TaskWorkerMessage } from './types.ts';
import { stat } from 'node:fs/promises';
import { withPgliteSavepoints } from '../database/savepoints';

type RpcMessage = Extract<TaskWorkerMessage, { type: 'rpc' }>;
type Scope = {
  engine: BrainEngine | ReservedConnection;
  finish: (commit: boolean) => void;
  done: Promise<unknown>;
  transactional: boolean;
};

function pageFingerprint(page: Page | null): string {
  return JSON.stringify(page ? [page.id, page.content_hash, page.updated_at, page.deleted_at] : null);
}

export class TaskEngineHost {
  private scopes = new Map<number, Scope>();
  private scopeSequence = 0;
  private closed = false;
  private initialModel = taskModelFingerprint();
  private pages = new Map<string, string>();
  private pending = new Set<Promise<unknown>>();
  private cycleLocks = new Set<string>();
  private currentFile?: { path: string; size: number; mtimeMs: number };

  constructor(
    private owner: BrainEngine,
    private jobId: number,
    private token: string,
    private checkpoint: (progress: Record<string, unknown>) => Promise<void>,
  ) {}

  private async fence(tx: BrainEngine): Promise<void> {
    if (this.closed) throw new Error('任务执行已停止');
    const rows = await tx.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active'
       AND lock_token = $2 AND lock_until > now() FOR UPDATE`, [this.jobId, this.token],
    );
    if (!rows.length) throw new Error('任务已取消或执行租约已失效');
    if (taskModelFingerprint() !== this.initialModel) throw new Error('向量模型配置已改变，请使用当前配置重新执行任务');
  }

  private async validateFile(): Promise<void> {
    if (!this.currentFile) return;
    const current = await stat(this.currentFile.path);
    if (current.size !== this.currentFile.size || current.mtimeMs !== this.currentFile.mtimeMs) {
      throw new Error('原始文件在处理期间已改变，请重新导入');
    }
  }

  async dispatch(message: RpcMessage): Promise<unknown> {
    if (this.closed) throw new Error('任务执行已停止');
    const operation = this.perform(message);
    this.pending.add(operation);
    try { return await operation; }
    finally { this.pending.delete(operation); }
  }

  private async perform(message: RpcMessage): Promise<unknown> {
    const { method, args, scope: scopeId } = message;
    if (scopeId === undefined && method === 'purgeDeletedPages' && !(args[1] as { limit?: number } | undefined)?.limit) {
      const slugs: string[] = [];
      while (true) {
        const result = await this.dispatch({ ...message, args: [args[0], { limit: 50 }] }) as { slugs: string[]; count: number };
        slugs.push(...result.slugs);
        if (result.count < 50) return { slugs, count: slugs.length };
      }
    }
    if (scopeId === undefined && method === 'listPages' && Number((args[0] as PageFilters | undefined)?.limit ?? 100) > 200) {
      const filters = args[0] as PageFilters;
      const ids = await this.owner.listPageIds(filters);
      const rows: Page[] = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        if (this.closed) throw new Error('任务执行已停止');
        const pages = await this.owner.listPages({ ...filters, pageIds: ids.slice(offset, offset + 200), limit: 200, offset: 0 });
        const byId = new Map(pages.map(page => [page.id, page]));
        for (const id of ids.slice(offset, offset + 200)) {
          const page = byId.get(id);
          if (page) rows.push(page);
        }
      }
      return rows;
    }
    if (scopeId === undefined && method === 'batchLoadEmotionalInputs') {
      const options = args[1] as { sourceId?: string } | undefined;
      const slugs = args[0] as string[] | undefined;
      if (slugs && slugs.length <= 50) return this.owner.batchLoadEmotionalInputs(slugs, options);
      const refs = (await this.owner.listAllPageRefs()).filter(ref => (!options?.sourceId || ref.source_id === options.sourceId) && (!slugs || slugs.includes(ref.slug)));
      const rows = [];
      for (let offset = 0; offset < refs.length; offset += 50) {
        if (this.closed) throw new Error('任务执行已停止');
        const batch = refs.slice(offset, offset + 50);
        for (const sourceId of new Set(batch.map(ref => ref.source_id))) {
          rows.push(...await this.owner.batchLoadEmotionalInputs(batch.filter(ref => ref.source_id === sourceId).map(ref => ref.slug), { sourceId }));
        }
      }
      return rows;
    }
    if (scopeId === undefined && ['addLinksBatch', 'addTimelineEntriesBatch', 'addTakesBatch', 'setEmotionalWeightBatch', 'markPagesExtractedBatch', 'deletePages', 'deleteCodeEdgesForChunks'].includes(method)
      && Array.isArray(args[0]) && args[0].length > 50) {
      let total = 0;
      const rows: unknown[] = [];
      for (let offset = 0; offset < args[0].length; offset += 50) {
        const value = await this.dispatch({ ...message, args: [args[0].slice(offset, offset + 50), ...args.slice(1)] });
        if (typeof value === 'number') total += value;
        if (Array.isArray(value)) rows.push(...value);
      }
      return method === 'deletePages' ? rows : ['markPagesExtractedBatch', 'deleteCodeEdgesForChunks'].includes(method) ? undefined : total;
    }
    if (scopeId === undefined && method === 'upsertChunks' && Array.isArray(args[1]) && args[1].length > 32) {
      const options = args[2] as { sourceId?: string; replaceExisting?: boolean } | undefined;
      for (let offset = 0; offset < args[1].length; offset += 32) {
        await this.dispatch({ ...message, args: [args[0], args[1].slice(offset, offset + 32), { ...options, replaceExisting: false }] });
      }
      if (options?.replaceExisting !== false) await this.dispatch({ ...message, method: 'executeRaw', args: [
        `DELETE FROM content_chunks WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2) AND chunk_index != ALL($3::int[])`,
        [args[0], options?.sourceId ?? 'default', args[1].map(chunk => chunk.chunk_index)],
      ] });
      return;
    }
    if (method === 'task.checkpoint') {
      await this.checkpoint(args[0] as Record<string, unknown>);
      return null;
    }
    if (method === 'task.inputFile') {
      this.currentFile = args[0] as typeof this.currentFile;
      return null;
    }
    if (method === 'scope.close') {
      const scope = scopeId === undefined ? undefined : this.scopes.get(scopeId);
      if (!scope) throw new Error('任务事务已关闭');
      scope.finish(args[0] === true);
      try { return await scope.done; }
      finally { this.scopes.delete(scopeId!); }
    }
    const parent = scopeId === undefined ? undefined : this.scopes.get(scopeId);
    if (scopeId !== undefined && !parent) throw new Error('任务事务已关闭');
    const engine = parent?.engine ?? this.owner;
    if (method === 'transaction.open' || method === 'withReservedConnection.open') {
      if (!('transaction' in engine)) throw new Error('保留连接不能开启业务事务');
      const id = ++this.scopeSequence;
      let readyResolve!: () => void;
      let readyReject!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      let finish!: (commit: boolean) => void;
      const completed = new Promise<boolean>(resolve => { finish = resolve; });
      const transactional = method === 'transaction.open';
      if (transactional) await this.validateFile();
      const run = async (connection: BrainEngine | ReservedConnection) => {
        await Promise.resolve();
        if (this.closed) throw new Error('任务执行已停止');
        if (transactional) await this.fence(connection as BrainEngine);
        if (this.closed) throw new Error('任务执行已停止');
        const scoped = transactional ? withPgliteSavepoints(connection as BrainEngine) : connection;
        this.scopes.set(id, { engine: scoped, finish, done, transactional });
        readyResolve();
        if (!await completed) throw new Error('任务事务已回滚');
        if (transactional) await this.fence(connection as BrainEngine);
      };
      const base = engine as BrainEngine;
      const done = transactional ? base.transaction(run) : base.withReservedConnection(run);
      void done.catch(readyReject);
      await ready;
      return id;
    }
    if (['connect', 'disconnect', 'initSchema', 'runMigration', 'constructor', 'transaction', 'withReservedConnection'].includes(method)) {
      throw new Error(`后台任务不能操作数据库生命周期：${method}`);
    }
    const call = (engine as unknown as Record<string, unknown>)[method];
    if (typeof call !== 'function') throw new Error(`不支持的数据库调用：${method}`);
    const readOnly = /^(get|list|find|search|count|resolve|traverse|is|has|inspect)/.test(method)
      || (method === 'executeRaw' && /^\s*SELECT\b/i.test(String(args[0])) && !/pg_advisory|FOR\s+UPDATE/i.test(String(args[0])));
    const invoke = async (target: BrainEngine | ReservedConnection) => {
      if (this.closed) throw new Error('任务执行已停止');
      const fn = (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method];
      const pageWrite = ['putPage', 'upsertChunks', 'deleteChunks', 'setPageAliases'].includes(method);
      let key: string | undefined;
      if (pageWrite && 'getPage' in target) {
        const sourceId = method === 'setPageAliases' ? String(args[1])
          : String((args[2] as { sourceId?: string } | undefined)?.sourceId
            ?? (method === 'deleteChunks' ? (args[1] as { sourceId?: string } | undefined)?.sourceId : undefined)
            ?? 'default');
        const slug = String(args[0]);
        key = JSON.stringify([sourceId, slug]);
        await target.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`pmbrain_task_page:${key}`]);
        await target.executeRaw(`SELECT id FROM sources WHERE id = $1 AND archived = false FOR SHARE`, [sourceId]).then(rows => {
          if (!rows.length) throw new Error(`Source ${sourceId} 不存在或已归档`);
        });
        const current = await target.getPage(slug, { sourceId, includeDeleted: true });
        const expected = this.pages.get(key);
        if (expected !== undefined && pageFingerprint(current) !== expected) {
          throw new Error(`页面 ${sourceId}:${slug} 在处理期间已改变，请重新执行`);
        }
      }
      const result = await fn.apply(target, args);
      if (method === 'executeRaw' && /INSERT\s+INTO\s+gbrain_cycle_locks/i.test(String(args[0]))) {
        for (const row of result as Array<{ id: string }>) this.cycleLocks.add(row.id);
      }
      if (method === 'getPage') {
        const page = result as Page | null;
        const sourceId = page?.source_id ?? (args[1] as { sourceId?: string } | undefined)?.sourceId ?? 'default';
        const readKey = JSON.stringify([sourceId, String(args[0])]);
        if (!this.pages.has(readKey)) this.pages.set(readKey, pageFingerprint(page));
      }
      if (method === 'putPage' && key) this.pages.set(key, pageFingerprint(result as Page));
      return result;
    };
    if (parent?.transactional) return invoke(engine);
    if (readOnly) return invoke(engine);
    if (!('transaction' in engine)) {
      throw new Error('数据库索引或连接维护需要独占执行，请使用已有高级维护入口');
    }
    await this.validateFile();
    return (engine as BrainEngine).transaction(async tx => {
      await this.fence(tx);
      const value = await invoke(withPgliteSavepoints(tx));
      await this.fence(tx);
      return value;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    for (const scope of this.scopes.values()) scope.finish(false);
    await Promise.allSettled([...this.scopes.values()].map(scope => scope.done));
    this.scopes.clear();
    if (this.cycleLocks.size) {
      await this.owner.executeRaw(
        `DELETE FROM gbrain_cycle_locks WHERE id = ANY($1::text[]) AND holder_pid = $2`,
        [[...this.cycleLocks], process.pid],
      );
    }
  }
}
