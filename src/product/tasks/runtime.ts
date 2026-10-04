import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import type { BrainEngine } from '../../core/engine.ts';
import { MinionQueue } from '../../core/minions/queue.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import { MINION_DEFERRED, type MinionJob, type MinionJobContext } from '../../core/minions/types.ts';
import type { ConsoleRun } from '../../commands/natural-lang/types.ts';
import { resolveImportSourceIdForPath } from '../../commands/natural-lang/api.ts';
import { ALL_PHASES } from '../../core/cycle.ts';
import { assertDreamPresetAllowGenerative, assertPhasesAllowGenerative } from '../../core/model-usage.ts';
import { TaskEngineHost } from './engine-host.ts';
import type { DreamTaskInput, ImportTaskInput, ProductTask, TaskWorkerMessage } from './types.ts';
import { removeAdminUploadTempDir } from '../../commands/pmbrain-admin-support.ts';
import { appendTaskCheckpoint } from './checkpoint.ts';
import { TaskProgressAdapter, finishTaskProgress } from './progress-adapter.ts';
import type { TaskProductProgress } from '../../../shared/task-progress.ts';
import { withDatabasePriority } from '../database/priority';
import { SyncFileQueue, SYNC_FILE_QUEUE, SYNC_FILE_TASK } from './sync-file-queue.ts';
import type { MaintenanceCheckpoint, SyncFileInput } from './types.ts';
import { resolveSourceId } from '../../core/source-resolver.ts';

export const PRODUCT_TASK_QUEUE = 'pmbrain-product';
const TASK_NAME = 'pmbrain-product-task';
const DEFAULT_PRODUCT_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;
type Progress = { product?: TaskProductProgress; output?: string; result?: Record<string, unknown>; cancelRequested?: boolean; files?: Record<string, unknown>[] };

function toRun(job: MinionJob, stopping = false): ConsoleRun {
  const progress = (job.progress ?? {}) as Progress;
  const status: ConsoleRun['status'] = stopping ? 'running' : job.status === 'completed' ? 'completed'
    : job.status === 'cancelled' ? 'cancelled' : ['dead', 'failed', 'paused'].includes(job.status) ? 'failed'
    : ['active', 'waiting-children'].includes(job.status) ? 'running' : 'queued';
  const adapter = new TaskProgressAdapter(String(job.data.kind), progress.product);
  if (!progress.product) adapter.write(progress.output ?? '');
  const task = job.data.task as ProductTask;
  if (task?.type === 'import') adapter.view.material = { ...adapter.view.material,
    name: task.input.path.split(/[\\/]/).filter(Boolean).at(-1) ?? task.input.path,
    sourceId: task.input.sourceId ?? 'default', directory: task.input.directory === true,
  };
  return {
    product: finishTaskProgress(adapter.view, status, job.result ?? progress.result, job.error_text),
    id: `task-${job.id}`, kind: String(job.data.kind), command: [], status,
    trigger: job.data.trigger === 'scheduled' ? 'scheduled' : 'manual',
    stdout: progress.output ?? '', stderr: '', error: stopping ? '正在停止任务…' : job.error_text,
    exitCode: status === 'completed' ? 0 : ['failed', 'cancelled'].includes(status) ? 1 : null,
    startedAt: (job.started_at ?? job.created_at).toISOString(),
    completedAt: job.finished_at?.toISOString() ?? null,
    durationMs: job.finished_at ? job.finished_at.getTime() - (job.started_at ?? job.created_at).getTime() : null,
    result: job.result ?? progress.result,
  };
}

export class ProductTaskRuntime {
  private queue: MinionQueue;
  private worker: MinionWorker;
  private fileWorker: MinionWorker;
  private fileQueue: SyncFileQueue;
  private fileLoop: Promise<void> | null = null;
  private fileSessions = new Map<number, number>();
  private sessionViews = new Map<number, ConsoleRun>();
  private stoppingSessions = new Map<number, Promise<void>>();
  private idleFileThreads: Worker[] = [];
  private sessionRefresh = new Map<number, { timer: ReturnType<typeof setTimeout>; file?: string }>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private paused = false;
  private failure: Error | null = null;
  private cached: ConsoleRun[] = [];
  private refreshingRuns: Promise<void> | null = null;
  private executions = new Map<number, { cancel: () => void; done: Promise<unknown>; run: () => ConsoleRun; ownsLockedTransaction: () => boolean }>();

  constructor(private engine: BrainEngine) {
    this.queue = new MinionQueue(engine);
    this.fileQueue = new SyncFileQueue(engine);
    this.fileWorker = new MinionWorker(engine, { queue: SYNC_FILE_QUEUE, concurrency: 2, pollInterval: 100, healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000, ownsLockedTransaction: id => this.executions.get(id)?.ownsLockedTransaction() === true });
    this.fileWorker.register(SYNC_FILE_TASK, async context => {
      const sessionId = Number(context.data.sessionId);
      this.fileSessions.set(context.id, sessionId);
      try {
        const parent = await this.queue.getJob(sessionId);
        if (parent?.queue !== PRODUCT_TASK_QUEUE || parent.status !== 'waiting-children') throw new Error('同步会话已停止，文件尚未开始');
        this.scheduleSessionRefresh(sessionId, ((context.data.task as ProductTask).input as SyncFileInput).relativePath);
        return await withDatabasePriority(2, () => this.execute(context));
      } catch (error) {
        await this.fileQueue.pause(sessionId);
        for (const [id, owner] of this.fileSessions) if (owner === sessionId && id !== context.id) this.executions.get(id)?.cancel();
        await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', error_text = $2, lock_token = NULL, lock_until = NULL, updated_at = now() WHERE id = $1 AND status NOT IN ('completed','cancelled','dead','failed')`, [sessionId, error instanceof Error ? error.message : String(error)]);
        throw error;
      } finally {
        this.fileSessions.delete(context.id);
        this.scheduleSessionRefresh(sessionId);
      }
    });
    this.worker = new MinionWorker(engine, {
      queue: PRODUCT_TASK_QUEUE, concurrency: 2, pollInterval: 100,
      healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000,
      ownsLockedTransaction: id => this.executions.get(id)?.ownsLockedTransaction() === true,
    });
    this.worker.on('unhealthy', info => console.error('[tasks]', info));
    this.worker.register(TASK_NAME, job => withDatabasePriority((job.data.task as ProductTask).type === 'import' ? 2 : 3, () => this.execute(job)));
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.queue.ensureSchema();
    await this.recoverSessions();
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
       error_text = '软件已退出，任务结果可能不完整。请查看已完成结果后手动继续；模型请求可能已产生费用。',
       finished_at = now(), updated_at = now()
       WHERE queue = $1 AND name = $2 AND status = 'active' AND data->'task'->'input'->>'preset' IS DISTINCT FROM 'quick'
       AND ($3::boolean OR lock_until <= now())`, [PRODUCT_TASK_QUEUE, TASK_NAME, this.engine.kind === 'pglite'],
    );
    await this.listRuns();
    this.fileLoop = withDatabasePriority(2, () => this.fileWorker.start()).catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); console.error('[tasks] file worker stopped:', error); });
    this.loop = withDatabasePriority(3, () => this.worker.start()).catch(error => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      console.error('[tasks] worker stopped:', error instanceof Error ? error.message : error);
    });
  }

  private async submit(task: ProductTask, kind: string, idempotencyKey?: string, trigger: 'manual' | 'scheduled' = 'manual', queue = this.queue): Promise<ConsoleRun> {
    if (this.stopped || this.paused) throw new Error('数据库维护期间暂不能提交新任务');
    if (this.failure) throw this.failure;
    const job = await queue.add(TASK_NAME, { task, kind, trigger }, {
      queue: PRODUCT_TASK_QUEUE, max_attempts: 1,
      timeout_ms: task.input.timeoutMs ?? DEFAULT_PRODUCT_TASK_TIMEOUT_MS,
      idempotency_key: idempotencyKey ?? `product:${randomUUID()}`,
    });
    const run = toRun(job);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 100);
    return run;
  }

  async submitImport(input: ImportTaskInput): Promise<ConsoleRun> {
    return withDatabasePriority(2, () => this.submitImportCore(input));
  }

  private async submitImportCore(input: ImportTaskInput): Promise<ConsoleRun> {
    if (!input.path.trim()) throw new Error('Path is required');
    const sourceId = await resolveImportSourceIdForPath(this.engine, input.path, input.sourceId);
    const file = await stat(input.path).catch(() => null);
    const key = `product-import:${createHash('sha256').update(JSON.stringify([input, sourceId, file?.size, file?.mtimeMs])).digest('hex')}`;
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET idempotency_key = NULL WHERE idempotency_key = $1
       AND status IN ('completed', 'dead', 'failed', 'cancelled', 'paused')`, [key],
    );
    return this.submit({ type: 'import', input: { ...input, directory: file?.isDirectory() ?? false, path: input.path.trim(), sourceId, timeoutMs: input.timeoutMs ?? 6 * 60 * 60_000 } }, 'import_path', key);
  }

  async submitDream(input: DreamTaskInput, trigger: 'manual' | 'scheduled' = 'manual'): Promise<ConsoleRun> {
    if (input.phase && input.preset) throw new Error('Dream phase and preset are mutually exclusive');
    if (input.phase && input.phase !== 'all' && !(ALL_PHASES as readonly string[]).includes(input.phase)) throw new Error(`Unsupported dream phase: ${input.phase}`);
    if (input.allSources && (input.sourceId || input.preset !== 'quick')) throw new Error('Dream allSources requires quick preset without sourceId');
    if (input.drainProposals && input.phase !== 'propose_takes') throw new Error('Dream proposal draining requires standalone propose_takes');
    for (const value of [input.maxPages, input.windowSeconds, input.timeoutMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('任务页数、窗口和超时必须为正数');
    }
    if (input.preset !== 'quick') {
      if (input.phase && input.phase !== 'all') assertPhasesAllowGenerative([input.phase]);
      else assertDreamPresetAllowGenerative(input.preset ?? 'full');
    }
    if (input.preset === 'quick' && !input.dryRun) {
      const sourceId = input.sourceId ? await resolveSourceId(this.engine, input.sourceId) : undefined;
      return this.engine.transaction(async tx => {
        await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext('pmbrain_quick_submit'))`);
        const existing = await tx.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE queue = $1 AND name = $2
          AND data->'task'->'input'->>'preset' = 'quick' AND data->'task'->'input'->>'dryRun' IS DISTINCT FROM 'true'
          AND status IN ('waiting','active','waiting-children') AND ($3::boolean OR data->'task'->'input'->>'allSources' = 'true'
            OR COALESCE(data->'task'->'input'->>'sourceId', 'default') = $4) LIMIT 1`, [PRODUCT_TASK_QUEUE, TASK_NAME, input.allSources === true, sourceId ?? 'default']);
        if (existing.length) return toRun((await new MinionQueue(tx).getJob(existing[0].id))!);
        const scoped = Object.create(tx) as BrainEngine;
        scoped.transaction = async fn => fn(tx);
        return this.submit({ type: 'dream', input: { ...input, sourceId } }, 'dream_quick', undefined, trigger, new MinionQueue(scoped));
      });
    }
    return this.submit({ type: 'dream', input }, `dream_${input.preset ?? (input.phase && input.phase !== 'all' ? input.phase : 'cycle')}`, undefined, trigger);
  }

  async submitEmbed(input: { catchUp?: boolean; forceReembed?: boolean } = {}): Promise<ConsoleRun> {
    return this.submit({ type: 'embed', input }, 'embed_stale');
  }

  async submitSync(): Promise<ConsoleRun> {
    return this.submit({ type: 'sync', input: {} }, 'sync_all');
  }

  async files(id: string, after = 0): Promise<import('../../../shared/task-progress.ts').SyncFileDetails | null> {
    if (!/^task-\d+$/.test(id) || !Number.isSafeInteger(after) || after < 0) return null;
    const parent = await this.queue.getJob(Number(id.slice(5)));
    if (parent?.queue !== PRODUCT_TASK_QUEUE || parent.name !== TASK_NAME) return null;
    const rows = await this.engine.executeRaw<{ id: number; sourceId: string; path: string; status: 'completed' | 'failed' | 'running' | 'pending'; error: string | null }>(
      `SELECT id, data->'task'->'input'->'options'->>'sourceId' AS "sourceId", data->'task'->'input'->>'relativePath' AS path,
       CASE WHEN result->>'status' IN ('failed','partial','error') OR status IN ('dead','failed') THEN 'failed'
       WHEN status = 'completed' THEN 'completed' WHEN status = 'active' THEN 'running' ELSE 'pending' END AS status,
       COALESCE(result->>'error', error_text) AS error
       FROM minion_jobs WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND id > $3
       AND data->>'superseded' IS DISTINCT FROM 'true' ORDER BY id LIMIT 51`, [SYNC_FILE_QUEUE, parent.id, after]);
    return { rows: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null };
  }

  async listRuns(): Promise<ConsoleRun[]> {
    if (this.executions.size) {
      if (!this.refreshingRuns) {
        this.refreshingRuns = withDatabasePriority(3, () => this.queue.getJobs({ queue: PRODUCT_TASK_QUEUE, name: TASK_NAME, limit: 100 }))
          .then(jobs => { this.cached = jobs.map(job => toRun(job)); })
          .catch(error => console.error('[tasks] history read failed:', error instanceof Error ? error.message : error))
          .finally(() => { this.refreshingRuns = null; });
      }
      return this.cachedRuns();
    }
    this.cached = (await this.queue.getJobs({ queue: PRODUCT_TASK_QUEUE, name: TASK_NAME, limit: 100 }))
      .map(job => toRun(job, job.status === 'cancelled' && this.executions.has(job.id)));
    return this.cached;
  }

  cachedRuns(): ConsoleRun[] {
    const live = [...this.executions.values()].map(execution => execution.run()).filter(run => run.kind !== 'sync_file');
    live.push(...[...this.sessionViews.values()].filter(run => !live.some(row => row.id === run.id)));
    return [...live, ...this.cached.filter(row => !live.some(run => run.id === row.id))]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
  }

  async getRun(id: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const execution = this.executions.get(Number(id.slice(5)));
    if (execution) return execution.run();
    const session = this.sessionViews.get(Number(id.slice(5)));
    if (session && ['running', 'queued'].includes(session.status)) return session;
    const job = await this.queue.getJob(Number(id.slice(5)));
    if (job?.queue !== PRODUCT_TASK_QUEUE || job.name !== TASK_NAME) return null;
    const run = toRun(job, job.status === 'cancelled' && this.executions.has(job.id));
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 100);
    return run;
  }

  async cancel(id: string): Promise<ConsoleRun | null> {
    const run = await this.getRun(id);
    if (!run || !['running', 'queued'].includes(run.status)) return run;
    const jobId = Number(id.slice(5));
    if (run.kind === 'dream_quick') {
      if (!this.stoppingSessions.has(jobId)) {
        this.sessionViews.set(jobId, { ...run, status: 'running', error: '正在停止任务…' });
        const pending = this.stopSession(jobId).finally(() => { this.stoppingSessions.delete(jobId); this.sessionViews.delete(jobId); });
        this.stoppingSessions.set(jobId, pending);
      }
      await this.stoppingSessions.get(jobId);
      return this.getRun(id);
    }
    const execution = this.executions.get(jobId);
    execution?.cancel();
    await withDatabasePriority(0, () => this.queue.cancelJob(jobId));
    await execution?.done;
    return this.getRun(id);
  }

  async requestCancel(id: string): Promise<ConsoleRun | null> {
    const view = await this.getRun(id);
    if (view?.kind === 'dream_quick' && ['running','queued'].includes(view.status)) {
      void this.cancel(id).catch(error => console.error('[tasks] stop sync:', error));
      return { ...view, status: 'running', error: '正在停止任务…' };
    }
    const execution = /^task-\d+$/.test(id) ? this.executions.get(Number(id.slice(5))) : undefined;
    if (!execution) return this.cancel(id);
    execution.cancel();
    void withDatabasePriority(0, () => this.queue.cancelJob(Number(id.slice(5))))
      .catch(error => console.error('[tasks] cancel failed:', error instanceof Error ? error.message : error));
    return execution.run();
  }

  async retry(id: string): Promise<ConsoleRun | null> {
    const run = await this.getRun(id);
    if (!run) return null;
    if (!['failed', 'cancelled'].includes(run.status) && !(run.kind === 'dream_quick' && (run.result as Record<string, unknown> | undefined)?.status === 'partial')) throw new Error('只有失败、中断或已取消的任务可以重新执行');
    const record = await this.queue.getJob(Number(id.slice(5)));
    const task = record!.data.task as ProductTask;
    if (task.type === 'dream' && task.input.preset === 'quick' && !task.input.dryRun) {
      const jobId = Number(id.slice(5));
      await this.stoppingSessions.get(jobId);
      await Promise.allSettled([...this.fileSessions].filter(([, owner]) => owner === jobId).map(([child]) => this.executions.get(child)?.done));
      const checkpoint = task.input.checkpoint;
      if (checkpoint) {
        checkpoint.reports = {};
        for (const key of Object.keys(checkpoint.phases)) checkpoint.phases[key] = checkpoint.phases[key].filter(phase => ['lint','backlinks'].includes(phase.phase));
        await this.engine.executeRaw(`UPDATE minion_jobs SET data = $2::jsonb WHERE id = $1`, [jobId, { ...record!.data, task }]);
      }
      await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', result = NULL WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND result->>'status' IN ('failed','error','partial')`, [SYNC_FILE_QUEUE, jobId]);
      this.sessionViews.delete(jobId);
      await this.fileQueue.resume(jobId);
      return this.getRun(id);
    }
    if (task.type === 'import') {
      return this.submitImport({ ...task.input, resumeCheckpointId: Number(id.slice(5)) });
    }
    if (task.type === 'dream') return this.submitDream(task.input);
    if (task.type === 'sync') return this.submitSync();
    if (task.type === 'embed') return this.submitEmbed(task.input);
    throw new Error('文件任务请通过快速维护继续');
  }

  private async execute(context: MinionJobContext): Promise<unknown> {
    if (this.stopped || this.paused) throw new Error('后台任务执行器已停止，任务未开始，请稍后重试');
    context.signal.throwIfAborted();
    context.shutdownSignal.throwIfAborted();
    const record = await this.queue.getJob(context.id);
    if (!record?.lock_token) throw new Error('任务执行租约无效');
    const structuredTask = record.data.task as ProductTask;
    if (structuredTask.type === 'dream' && structuredTask.input.preset === 'quick' && record.attempts_started > 1) {
      const counts = await this.fileQueue.counts(context.id);
      if (counts.total > 0) record.progress = { ...(record.progress as Progress ?? {}), product: { ...toRun(record).product!, syncFiles: counts } };
    }
    if (record.attempts_started > 1 && structuredTask.type !== 'sync-file' && !(structuredTask.type === 'dream' && structuredTask.input.preset === 'quick' && !structuredTask.input.dryRun)) throw new Error('任务执行曾中断，结果不确定，请查看已完成内容后手动继续');
    let progress = (record.progress ?? {}) as Progress;
    const adapter = new TaskProgressAdapter(String(record.data.kind), toRun(record).product);
    let progressTail = Promise.resolve();
    let persisting = false;
    let progressVersion = 0;
    const persist = () => {
      progress.product = adapter.view;
      progressVersion++;
      if (!persisting) {
        persisting = true;
        progressTail = (async () => {
          let saved = 0;
          while (saved < progressVersion) {
            const version = progressVersion;
            await context.updateProgress(structuredClone(progress));
            saved = version;
          }
        })().finally(() => { persisting = false; });
      }
      return progressTail;
    };
    const host = new TaskEngineHost(this.engine, context.id, record.lock_token, async file => {
      await appendTaskCheckpoint(context.id, file);
      progress.files = [...(progress.files ?? []), file].slice(-100);
      await persist();
    }, structuredTask.type === 'sync-file', structuredTask.type === 'sync-file' ? structuredTask.input : undefined);
    const workerPath = /\/(?:~BUN|\$bunfs)\//.test(decodeURIComponent(import.meta.url))
      ? './product/tasks/task-worker.ts'
      : new URL(import.meta.url.endsWith('.ts') ? './task-worker.ts' : './task-worker.js', import.meta.url);
    const thread = structuredTask.type === 'sync-file' && this.idleFileThreads.length ? this.idleFileThreads.pop()! : new Worker(workerPath, { env: { ...process.env } });
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    thread.once('exit', stop);
    let settleResolve!: (value: unknown) => void;
    let settleReject!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
    let cancelRequested = false;
    let completed = false;
    let flush: ReturnType<typeof setInterval> | undefined;
    const cancel = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      thread.postMessage({ type: 'cancel' });
      settleReject(new Error('任务已取消'));
    };
    const finished = (async () => {
      try { return await result; }
      finally {
        clearInterval(flush);
        thread.removeAllListeners('message');
        try { await host.close(); }
        finally {
          try {
            if (structuredTask.type === 'sync-file' && completed && !cancelRequested && !this.stopped && !this.paused) {
              thread.removeAllListeners('error');
              thread.removeAllListeners('exit');
              this.idleFileThreads.push(thread);
            } else {
              await thread.terminate();
              await stopped;
            }
            await progressTail;
            const task = record.data.task as ProductTask;
            if (task.type === 'import' && task.input.stagingDir && completed) {
              await removeAdminUploadTempDir(task.input.stagingDir);
            }
          } finally { this.executions.delete(context.id); }
        }
      }
    })();
    this.executions.set(context.id, { cancel, done: finished.catch(() => {}), ownsLockedTransaction: () => host.ownsLockedTransaction(), run: () => {
      progress.product = adapter.view;
      return toRun({ ...record, progress }, cancelRequested);
    } });
    context.signal.addEventListener('abort', cancel, { once: true });
    context.shutdownSignal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted || context.shutdownSignal.aborted) cancel();
    thread.once('error', error => settleReject(error instanceof Error ? error : new Error(String(error))));
    thread.once('exit', code => settleReject(new Error(`任务 Worker 意外退出（${code}）`)));
    thread.on('message', (message: TaskWorkerMessage) => {
      if (message.type === 'rpc') {
        const dispatch = async () => {
          if (message.method === 'task.syncFile') return this.fileQueue.enqueue(context.id, record.lock_token!, message.args[0] as SyncFileInput);
          if (message.method === 'task.maintenanceCheckpoint') {
            if (structuredTask.type !== 'dream') throw new Error('无效的维护检查点');
            structuredTask.input.checkpoint = message.args[0] as MaintenanceCheckpoint;
            const rows = await this.engine.executeRaw(`UPDATE minion_jobs SET data = $3::jsonb, updated_at = now() WHERE id = $1 AND status = 'active' AND lock_token = $2 RETURNING id`, [context.id, record.lock_token, record.data]);
            if (!rows.length) throw new Error('维护任务已停止或租约失效');
            return null;
          }
          return host.dispatch(message);
        };
        void withDatabasePriority(['import','sync-file'].includes(structuredTask.type) ? 2 : 3, dispatch).then(value => {
          if (!cancelRequested) thread.postMessage({ type: 'reply', id: message.id, value });
        }, error => {
          if (!cancelRequested) thread.postMessage({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) });
        });
      } else if (message.type === 'log') {
        adapter.write(message.text);
        progress.output = `${progress.output ?? ''}${message.text}`.slice(-100_000);
      } else if (message.type === 'progress') {
        if (message.phases) adapter.plan(message.phases);
        if (message.scope) adapter.scope(message.scope);
        if (message.event) adapter.event(message.event);
        if (message.syncScan) adapter.view.syncScan = message.syncScan;
        if (message.page && adapter.view.material) adapter.view.material.page = message.page;
      } else if (message.type === 'result') {
        completed = true;
        progress.result = message.result;
        void persist().then(() => settleResolve(message.result), settleReject);
      } else if (message.type === 'error') {
        progress.result = message.result;
        void persist().then(() => settleReject(new Error(message.error)), settleReject);
      } else if (message.type === 'deferred') {
        void persist().then(() => settleResolve(MINION_DEFERRED), settleReject);
      }
    });
    flush = setInterval(() => void persist().catch(settleReject), 1000);
    thread.postMessage({ type: 'start', kind: this.engine.kind, task: record.data.task });
    try {
      const outcome = await finished;
      if (outcome === MINION_DEFERRED) {
        const counts = await this.fileQueue.counts(context.id);
        adapter.view.syncFiles = counts;
        adapter.view.processed = counts.completed + counts.failed;
        adapter.view.total = counts.total;
        adapter.view.stage = '同步资料';
        adapter.view.phasePercent = counts.total ? Math.floor((counts.completed + counts.failed) / counts.total * 100) : null;
        await persist();
        await this.fileQueue.release(context.id, record.lock_token);
        this.sessionViews.set(context.id, toRun({ ...record, progress, status: counts.remaining > 0 ? 'waiting-children' : 'waiting' }));
        this.scheduleSessionRefresh(context.id);
      } else {
        this.sessionViews.delete(context.id); this.fileQueue.clear(context.id);
        if (structuredTask.type === 'dream' && structuredTask.input.preset === 'quick') await this.fileQueue.cleanup(context.id).catch(error => console.error('[tasks] snapshot cleanup:', error));
      }
      return outcome;
    }
    finally {
      clearInterval(flush);
      context.signal.removeEventListener('abort', cancel);
      context.shutdownSignal.removeEventListener('abort', cancel);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const refresh of this.sessionRefresh.values()) clearTimeout(refresh.timer);
    this.sessionRefresh.clear();
    this.worker.stop();
    this.fileWorker.stop();
    await this.engine.executeRaw(`UPDATE minion_jobs SET data = jsonb_set(data, '{resumeOnRestart}', 'true'::jsonb)
      WHERE queue = $1 AND data->'task'->'input'->>'preset' = 'quick' AND status IN ('active','waiting-children')`, [PRODUCT_TASK_QUEUE]);
    const interrupted = [...this.executions.keys()];
    for (const execution of this.executions.values()) execution.cancel();
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    await this.loop;
    await this.fileLoop;
    await Promise.all(this.idleFileThreads.splice(0).map(thread => thread.terminate()));
    await this.refreshingRuns;
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    if (interrupted.length) {
      await this.engine.executeRaw(
        `UPDATE minion_jobs SET status = 'paused', error_text = '软件退出，任务已中断。请查看已完成内容后手动继续；模型请求可能已产生费用。'
         WHERE id = ANY($1::bigint[]) AND queue = $2 AND status = 'dead'`, [interrupted, PRODUCT_TASK_QUEUE],
      );
    }
  }

  async pauseAndDrain(): Promise<void> {
    this.paused = true;
    this.worker.stop();
    this.fileWorker.stop();
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    await this.loop;
    await this.fileLoop;
    await Promise.all(this.idleFileThreads.splice(0).map(thread => thread.terminate()));
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    this.loop = null;
  }

  async resume(): Promise<void> {
    this.paused = false;
    this.failure = null;
    if (!this.stopped) await this.start();
  }

  private async refreshSession(id: number, file?: string) {
    const job = await this.queue.getJob(id);
    if (!job || ['completed','cancelled','dead','failed','paused'].includes(job.status)) { this.sessionViews.delete(id); return; }
    const run = toRun(job);
    const counts = await this.fileQueue.counts(id);
    if (run.product && counts.total > 0) {
      run.product.syncFiles = counts;
      run.product.processed = counts.completed + counts.failed;
      run.product.total = counts.total;
      if (job.status === 'waiting-children') {
        run.product.stage = '同步资料';
        run.product.phasePercent = Math.floor((counts.completed + counts.failed) / counts.total * 100);
        if (file) run.product.file = file;
      }
      job.progress = { ...(job.progress as Record<string, unknown> ?? {}), product: run.product };
      await this.engine.executeRaw(`UPDATE minion_jobs SET progress = $2::jsonb WHERE id = $1 AND status IN ('waiting-children','waiting')`, [id, job.progress]);
    }
    this.sessionViews.set(id, run);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 100);
  }

  private scheduleSessionRefresh(id: number, file?: string) {
    if (this.stopped) return;
    const queued = this.sessionRefresh.get(id);
    if (queued) { if (file) queued.file = file; return; }
    const refresh = { file, timer: setTimeout(() => {
      this.sessionRefresh.delete(id);
      if (!this.stopped) void this.refreshSession(id, refresh.file).catch(error => console.error('[tasks] sync progress:', error));
    }, 500) };
    this.sessionRefresh.set(id, refresh);
  }

  private async stopSession(id: number) {
    this.fileQueue.clear(id);
    this.executions.get(id)?.cancel();
    const files = [...this.fileSessions].filter(([, owner]) => owner === id).map(([child]) => this.executions.get(child)).filter(Boolean);
    for (const execution of files) execution!.cancel();
    await withDatabasePriority(0, async () => {
      await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'cancelled', lock_token = NULL, lock_until = NULL,
        data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), finished_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('waiting','active','waiting-children')`, [id]);
      await this.fileQueue.pause(id);
    });
    await Promise.allSettled([this.executions.get(id)?.done, ...files.map(execution => execution!.done)]);
  }

  private async recoverSessions() {
    const rows = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs AS parent WHERE queue = $1
      AND data->'task'->'input'->>'preset' = 'quick' AND (status IN ('active','waiting-children')
        OR (status = 'paused' AND data->>'resumeOnRestart' = 'true'))
      AND ($2::boolean OR ((parent.lock_until IS NULL OR parent.lock_until <= now()) AND NOT EXISTS (
        SELECT 1 FROM minion_jobs child WHERE (child.data->>'sessionId')::bigint = parent.id
        AND child.status = 'active' AND child.lock_until > now())))`, [PRODUCT_TASK_QUEUE, this.engine.kind === 'pglite']);
    for (const { id } of rows) {
      const uncertain = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE queue = $1
        AND (data->>'sessionId')::bigint = $2 AND status NOT IN ('completed','waiting','delayed')
        AND COALESCE((data->'task'->'input'->>'modelMayRun')::boolean, data->'task'->'input'->'options'->>'documentOcr' = 'true')
        AND attempts_started > 0 AND NOT EXISTS (SELECT 1 FROM pages WHERE slug = result->>'slug'
          AND source_id = data->'task'->'input'->'options'->>'sourceId' AND deleted_at IS NULL AND content_hash = result->>'pageHash') LIMIT 1`, [SYNC_FILE_QUEUE, id]);
      if (uncertain.length) {
        await this.fileQueue.pause(id);
        await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
          data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), error_text = '模型处理曾中断，结果及费用不确定，请查看已完成资料后继续。' WHERE id = $1`, [id]);
      } else {
        const parent = await this.queue.getJob(id);
        const task = parent?.data.task as ProductTask;
        const synced = task.type === 'dream' && Object.values(task.input.checkpoint?.phases ?? {}).some(phases => phases.some(phase => phase.phase === 'sync'));
        if (synced && parent?.status === 'active') {
          await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
            data = jsonb_set(data, '{resumeOnRestart}', 'false'::jsonb), error_text = '后续知识增强阶段曾中断，请查看已完成资料后继续。' WHERE id = $1`, [id]);
        } else {
          await this.fileQueue.pause(id);
          await this.fileQueue.resume(id);
        }
      }
    }
  }
}
