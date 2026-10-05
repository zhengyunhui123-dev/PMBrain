import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat, unlink, rmdir } from 'node:fs/promises';
import { basename, join, dirname, resolve, sep } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { MinionQueue } from '../../core/minions/queue.ts';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import type { SyncFileInput } from './types.ts';
import type { ImportResult } from '../../core/import-file.ts';
import { rowToMinionJob, type MinionJob } from '../../core/minions/types.ts';
import { importFile, isImageFilePath } from '../../core/import-file.ts';
import { isCodeFilePath, isOfficeFilePath } from '../../core/sync.ts';
import { isSessionExportPath } from '../../core/conversation-parser/session-import.ts';

export const SYNC_FILE_QUEUE = 'pmbrain-sync-files';
export const SYNC_FILE_TASK = 'pmbrain-sync-file';

export class SyncFileQueue {
  private queue: MinionQueue;
  private sessions = new Map<number, { rows: MinionJob[]; complete: boolean }>();
  private caches = new Map<string, { rows: Array<{ input: SyncFileInput; result: ImportResult & { pageHash?: string }; actualHash: string | null }>; complete: boolean }>();
  constructor(private engine: BrainEngine, private observe?: (job:MinionJob)=>void, private allowed: (id:number)=>boolean = ()=>true) { this.queue = new MinionQueue(engine); }

  async enqueue(sessionId: number, token: string, file: SyncFileInput): Promise<ImportResult & { deferred?: boolean; unchanged?: boolean }> {
    if (!this.allowed(sessionId)) throw new Error('同步任务已停止');
    const parent = await this.queue.getJob(sessionId);
    if (parent?.status !== 'active' || parent.lock_token !== token) throw new Error('同步任务已停止或租约失效');
    const key = createHash('sha256').update(JSON.stringify([sessionId, file.options.sourceId, file.sourceRoot, file.relativePath, file.hash, file.fingerprint])).digest('hex');
    if (!this.sessions.has(sessionId)) {
      const raw = await this.engine.executeRaw<Record<string, unknown>>(`SELECT * FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 ORDER BY id DESC LIMIT 5001`, [SYNC_FILE_QUEUE, sessionId]);
      const rows = raw.map(rowToMinionJob);
      this.sessions.set(sessionId, { rows: rows.slice(0, 5000), complete: rows.length <= 5000 });
    }
    const session = this.sessions.get(sessionId)!;
    const samePath = session.rows.filter(job => {
      const input = (job.data.task as { input: SyncFileInput }).input;
      return input.relativePath === file.relativePath && input.options.sourceId === file.options.sourceId;
    });
    if (!session.complete || samePath.some(job => {
      const input = (job.data.task as { input: SyncFileInput }).input;
      return input.hash !== file.hash || input.fingerprint !== file.fingerprint || input.sourceRoot !== file.sourceRoot;
    })) await this.engine.executeRaw(`UPDATE minion_jobs SET data = jsonb_set(data, '{superseded}', 'true'::jsonb),
      status = CASE WHEN status IN ('paused','delayed','waiting') THEN 'cancelled' ELSE status END, updated_at = now()
      WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND data->'task'->'input'->>'relativePath' = $3
      AND data->'task'->'input'->'options'->>'sourceId' = $4
      AND (data->'task'->'input'->>'hash' <> $5 OR data->'task'->'input'->>'fingerprint' <> $6 OR data->'task'->'input'->>'sourceRoot' <> $7)`,
      [SYNC_FILE_QUEUE, sessionId, file.relativePath, file.options.sourceId ?? 'default', file.hash, file.fingerprint, file.sourceRoot]);
    let job = samePath.find(row => row.idempotency_key === `sync-file:${key}`);
    if (!job && !session.complete) {
      const existing = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE idempotency_key = $1`, [`sync-file:${key}`]);
      if (existing.length) job = await this.queue.getJob(existing[0].id) ?? undefined;
    }
    if (job) {
      this.observe?.(job);
      if (job?.result && (job.status === 'completed' || (job.result.pageHash && ['paused','delayed','waiting'].includes(job.status)))) {
        const stored = job.result as unknown as ImportResult & { pageHash?: string };
        if (!stored.pageHash) return stored;
        const page = await this.engine.getPage(stored.slug, { sourceId: file.options.sourceId });
        if (page && !page.deleted_at && page.content_hash === stored.pageHash) {
          if (job.status !== 'completed') await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now(), lock_token = NULL, lock_until = NULL WHERE id = $1 AND status IN ('paused','delayed','waiting')`, [job.id]);
          return stored;
        }
        await this.engine.executeRaw(`UPDATE minion_jobs SET idempotency_key = NULL, data = jsonb_set(data, '{superseded}', 'true'::jsonb) WHERE id = $1`, [job.id]);
      } else {
        if (['dead', 'failed'].includes(job.status)) throw new Error(job.error_text ?? '文件任务执行失败');
        return { slug: '', status: 'skipped', chunks: 0, deferred: true };
      }
    }
    const cacheKey = JSON.stringify([sessionId, file.options.sourceId ?? 'default', file.sourceRoot]);
    if (!this.caches.has(cacheKey)) {
      const rows = await this.engine.executeRaw<{ input: SyncFileInput; result: ImportResult & { pageHash?: string }; actualHash: string | null }>(
        `SELECT j.data->'task'->'input' AS input, j.result, p.content_hash AS "actualHash"
         FROM minion_jobs j LEFT JOIN pages p ON p.slug = j.result->>'slug' AND p.source_id = $3 AND p.deleted_at IS NULL
         WHERE j.queue = $1 AND j.name = $2 AND j.status = 'completed'
         AND j.data->'task'->'input'->'options'->>'sourceId' = $3 AND j.data->'task'->'input'->>'sourceRoot' = $4
         AND j.result->>'status' IN ('imported','skipped') ORDER BY j.id DESC LIMIT 5001`,
        [SYNC_FILE_QUEUE, SYNC_FILE_TASK, file.options.sourceId ?? 'default', file.sourceRoot]);
      this.caches.set(cacheKey, { rows: rows.slice(0, 5000), complete: rows.length <= 5000 });
    }
    const cachedRows = this.caches.get(cacheKey)!;
    const match = cachedRows.rows.find(row => row.input.hash === file.hash && row.input.fingerprint === file.fingerprint && row.input.relativePath === file.relativePath && row.result.pageHash === row.actualHash);
    if (match?.result.pageHash) {
      const page = await this.engine.getPage(match.result.slug, { sourceId: file.options.sourceId });
      if (page && !page.deleted_at && page.content_hash === match.result.pageHash) return { ...match.result, status: 'skipped', chunks: 0, unchanged: true };
    }
    const cache = cachedRows.complete ? [] : await this.engine.executeRaw<{ result: ImportResult & { pageHash?: string } }>(
      `SELECT result FROM minion_jobs WHERE queue = $1 AND name = $2 AND status = 'completed'
       AND data->'task'->'input'->>'hash' = $3 AND data->'task'->'input'->>'fingerprint' = $4
       AND data->'task'->'input'->>'relativePath' = $5
       AND data->'task'->'input'->'options'->>'sourceId' = $6 AND data->'task'->'input'->>'sourceRoot' = $7
       AND result->>'status' IN ('imported','skipped') ORDER BY id DESC LIMIT 1`,
      [SYNC_FILE_QUEUE, SYNC_FILE_TASK, file.hash, file.fingerprint, file.relativePath, file.options.sourceId ?? 'default', file.sourceRoot],
    );
    const cached = cache[0]?.result;
    if (cached?.pageHash) {
      const page = await this.engine.getPage(cached.slug, { sourceId: file.options.sourceId });
      if (page && !page.deleted_at && page.content_hash === cached.pageHash) return { ...cached, status: 'skipped', chunks: 0, unchanged: true };
    }
    if (file.options.noEmbed && !(file.options.session && isSessionExportPath(file.relativePath)) && !isCodeFilePath(file.relativePath)
      && !isImageFilePath(file.relativePath) && !isOfficeFilePath(file.relativePath)) {
      const inspected = await importFile(this.engine, file.path, file.relativePath, { ...file.options, checkOnly: true });
      if (inspected.error === '同步检查：需要重新切分') file.options = {...file.options,forceRechunk:true};
      if (inspected.status === 'skipped' && !inspected.error) {
        await this.validate(file);
        const current = await this.queue.getJob(sessionId);
        if (current?.status !== 'active' || current.lock_token !== token) throw new Error('同步任务已停止或租约失效');
        return { ...inspected, unchanged: true };
      }
    }
    const bytes = await readFile(file.path);
    if (createHash('sha256').update(bytes).digest('hex') !== file.hash) throw new Error('原始文件在扫描期间已改变，请继续同步');
    const config = loadConfig();
    const brain = createHash('sha256').update(JSON.stringify([config?.engine, config?.database_path, config?.database_url])).digest('hex').slice(0, 24);
    const dir = join(gbrainPath('task-artifacts'), 'sync-files', brain, String(sessionId));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${key}-${basename(file.path)}`);
    await writeFile(path, bytes, { mode: 0o600 });
    const after = await this.queue.getJob(sessionId);
    if (!this.allowed(sessionId)) throw new Error('同步任务已停止');
    if (after?.status !== 'active' || after.lock_token !== token) throw new Error('同步任务已停止或租约失效');
    const added = await this.queue.add(SYNC_FILE_TASK, { sessionId, kind: 'sync_file', task: { type: 'sync-file', input: { ...file, path } } }, {
      queue: SYNC_FILE_QUEUE, delay: 24 * 60 * 60 * 1000, max_attempts: 1,
      timeout_ms: 6 * 60 * 60 * 1000, idempotency_key: `sync-file:${key}`, on_child_fail: 'continue',
    });
    if (session.rows.length < 5000) session.rows.push(added); else session.complete = false;
    this.observe?.(added);
    return { slug: '', status: 'skipped', chunks: 0, deferred: true };
  }

  async release(sessionId: number, token: string) {
    this.clear(sessionId);
    await this.engine.transaction(async tx => {
      const rows = await tx.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active' AND lock_token = $2 FOR UPDATE`, [sessionId, token]);
      if (!rows.length) throw new Error('同步任务已停止或租约失效');
      await tx.executeRaw(`UPDATE minion_jobs SET parent_job_id = $1, status = CASE WHEN status IN ('delayed','paused') THEN 'waiting' ELSE status END,
        delay_until = NULL, updated_at = now() WHERE queue = $2 AND (data->>'sessionId')::bigint = $1 AND data->>'superseded' IS DISTINCT FROM 'true'`, [sessionId, SYNC_FILE_QUEUE]);
      await tx.executeRaw(`UPDATE minion_jobs SET status = CASE WHEN EXISTS (
        SELECT 1 FROM minion_jobs WHERE parent_job_id = $1 AND status NOT IN ('completed','dead','failed','cancelled')
        ) THEN 'waiting-children' ELSE 'waiting' END, lock_token = NULL, lock_until = NULL, updated_at = now() WHERE id = $1`, [sessionId]);
    });
  }

  async pause(sessionId: number) {
    await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL, updated_at = now()
      WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND status IN ('waiting','delayed','active')`, [SYNC_FILE_QUEUE, sessionId]);
  }

  async resume(sessionId: number) {
    this.clear(sessionId);
    await this.engine.transaction(async tx => {
      await tx.executeRaw(`UPDATE minion_jobs SET status = 'delayed', parent_job_id = NULL, lock_token = NULL, lock_until = NULL,
        delay_until = now() + interval '1 day', error_text = NULL, updated_at = now()
        WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND status IN ('paused','dead','failed') AND data->>'superseded' IS DISTINCT FROM 'true'`, [SYNC_FILE_QUEUE, sessionId]);
      await tx.executeRaw(`UPDATE minion_jobs SET status = 'waiting', lock_token = NULL, lock_until = NULL, timeout_at = NULL,
        data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), error_text = NULL, finished_at = NULL, updated_at = now() WHERE id = $1`, [sessionId]);
    });
  }

  async counts(sessionId: number) {
    const rows = await this.engine.executeRaw<{ total: string; completed: string; failed: string }>(
      `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE status = 'completed' AND result->>'status' IN ('imported','skipped'))::text AS completed,
       count(*) FILTER (WHERE status IN ('dead','failed') OR result->>'status' IN ('failed','partial','error'))::text AS failed
       FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND data->>'superseded' IS DISTINCT FROM 'true'`, [SYNC_FILE_QUEUE, sessionId]);
    const { total, completed, failed } = rows[0];
    return { total: Number(total), completed: Number(completed), failed: Number(failed), remaining: Number(total) - Number(completed) - Number(failed) };
  }

  async validate(file: SyncFileInput) {
    await validateSyncFileSnapshot(file);
  }

  clear(sessionId: number) {
    this.sessions.delete(sessionId);
    for (const key of this.caches.keys()) if (JSON.parse(key)[0] === sessionId) this.caches.delete(key);
  }

  async cleanup(sessionId: number) {
    const root = resolve(gbrainPath('task-artifacts'), 'sync-files');
    let after = 0;
    while (true) {
      const rows = await this.engine.executeRaw<{ id: number; path: string }>(`SELECT id, data->'task'->'input'->>'path' AS path
        FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND id > $3 AND status = 'completed'
        AND result->>'status' IN ('imported','skipped') ORDER BY id LIMIT 200`, [SYNC_FILE_QUEUE, sessionId, after]);
      for (const row of rows) {
        const path = resolve(row.path);
        if (!path.startsWith(root + sep) || basename(dirname(path)) !== String(sessionId) || !/^[a-f0-9]{64}-/.test(basename(path))) throw new Error('文件任务快照清理路径无效');
        await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(dirname(path)).catch(error => { if (!['ENOENT','ENOTEMPTY'].includes(error.code)) throw error; });
      }
      if (rows.length < 200) return;
      after = rows.at(-1)!.id;
    }
  }
}

export async function validateSyncFileSnapshot(file: SyncFileInput) {
  const bytes = await readFile(file.path);
  if (createHash('sha256').update(bytes).digest('hex') !== file.hash) throw new Error('文件任务快照已改变');
  if (file.originalPath) {
    const current = await stat(file.originalPath);
    if (current.size !== file.originalSize || current.mtimeMs !== file.originalMtime
      || createHash('sha256').update(await readFile(file.originalPath)).digest('hex') !== file.hash) throw new Error('原始文件在处理期间已改变，请继续同步');
  }
}
