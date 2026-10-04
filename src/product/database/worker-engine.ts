import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { BrainEngine, ReservedConnection } from '../../core/engine.ts';
import type { EngineConfig } from '../../core/types.ts';
import { DatabaseAlreadyOwnedError, PgliteOpenError, PgliteProbeError, PgliteLockMetadataError, PglitePermissionError } from '../../core/pglite-errors.ts';
import { databasePriority } from './priority.ts';

type Reply = { id: number; value?: unknown; error?: { name: string; message: string; properties: Record<string, unknown> } };

function transferable(value: unknown): unknown {
  if (value instanceof AbortSignal || typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(transferable);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transferable(child)]));
  return value;
}

export class WorkerPgliteEngine {
  readonly kind = 'pglite';
  private thread: Worker | null = null;
  private replies: BroadcastChannel | null = null;
  private repliesClosed = false;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() { return this.proxy(); }

  private proxy(scope?: number): this {
    return new Proxy(this, { has: (target, property) => ['transaction', 'withReservedConnection', 'getPage', 'db'].includes(String(property)) || Reflect.has(target, property), get: (target, property) => {
      if (['kind', 'connect', 'disconnect'].includes(String(property))) {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (['then', '_db', '_sql'].includes(String(property))) return undefined;
      if (property === 'db') return {
        query: (sql: string, params?: unknown[]) => target.rpc('@db.query', [sql, params], scope),
        transaction: async (fn: (db: unknown) => Promise<unknown>) => target.scoped('transaction', async child => fn((child as any).db), scope),
      };
      if (property === 'transaction' || property === 'withReservedConnection') return (fn: (engine: BrainEngine | ReservedConnection) => Promise<unknown>) => target.scoped(String(property), fn, scope);
      return (...args: unknown[]) => target.rpc(String(property), args, scope);
    } });
  }

  private rpc(method: string, args: unknown[], scope?: number): Promise<unknown> {
    if (!this.thread) return Promise.reject(new Error('PGLite not connected. Call connect() first.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.thread!.postMessage({ id, method, args: args.map(transferable), scope, priority: databasePriority() }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private async scoped(method: string, fn: (engine: BrainEngine | ReservedConnection) => Promise<unknown>, parent?: number): Promise<unknown> {
    const scope = await this.rpc(`@${method}.open`, [], parent) as number;
    try {
      const value = await fn(this.proxy(scope) as unknown as BrainEngine);
      await this.rpc('@scope.close', [true], scope);
      return value;
    } catch (error) {
      await this.rpc('@scope.close', [false], scope).catch(() => {});
      throw error;
    }
  }

  async connect(config: EngineConfig): Promise<void> {
    if (!this.thread) {
      const path = /\/(?:~BUN|\$bunfs)\//.test(decodeURIComponent(import.meta.url)) ? './product/database/database-worker.ts' : new URL(import.meta.url.endsWith('.ts') ? './database-worker.ts' : './database-worker.js', import.meta.url);
      const channelName = `pmbrain-db-${randomUUID()}`;
      const replies = new BroadcastChannel(channelName);
      this.replies = replies;
      this.repliesClosed = false;
      const thread = new Worker(path, { env: { ...process.env, PMBRAIN_DB_CHANNEL: channelName } });
      this.thread = thread;
      const failed = (error: Error) => {
        if (this.thread === thread) this.thread = null;
        this.closeReplies();
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      thread.on('error', failed);
      thread.on('exit', code => failed(new Error(`数据库 Worker 已退出（${code}）`)));
      const accept = (reply: Reply) => {
        const request = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (!reply.error) { request?.resolve(reply.value); return; }
        const { name, message, properties } = reply.error;
        const error = name === 'DatabaseAlreadyOwnedError' ? new DatabaseAlreadyOwnedError({ ...properties, message } as ConstructorParameters<typeof DatabaseAlreadyOwnedError>[0])
          : name === 'PgliteOpenError' ? new PgliteOpenError(message, properties)
          : name === 'PgliteProbeError' ? new PgliteProbeError(message, properties)
          : name === 'PglitePermissionError' ? new PglitePermissionError(message, properties.databasePath as string | null)
          : name === 'PgliteLockMetadataError' ? new PgliteLockMetadataError(String(properties.lockPath), message)
          : new Error(message);
        Object.assign(error, properties, { name });
        request?.reject(error);
      };
      thread.on('message', accept);
      replies.onmessage = (event: MessageEvent<Reply>) => accept(event.data);
    }
    await this.rpc('connect', [config]);
  }

  async disconnect(): Promise<void> {
    const thread = this.thread;
    if (!thread) return;
    try {
      await this.rpc('disconnect', []);
      await thread.terminate();
    } finally {
      this.closeReplies();
      if (this.thread === thread) this.thread = null;
    }
  }

  private closeReplies(): void {
    if (this.repliesClosed) return;
    this.repliesClosed = true;
    const replies = this.replies;
    this.replies = null;
    try { replies?.close(); } catch { this.repliesClosed = true; }
  }
}
