import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import type { BrainEngine } from '../../core/engine.ts';
import { MinionQueue } from '../../core/minions/queue.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import type { MinionJob, MinionJobContext } from '../../core/minions/types.ts';
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

export const PRODUCT_TASK_QUEUE = 'pmbrain-product';
const TASK_NAME = 'pmbrain-product-task';
type Progress = { product?: TaskProductProgress; output?: string; result?: Record<string, unknown>; cancelRequested?: boolean; files?: Record<string, unknown>[] };

function toRun(job: MinionJob, stopping = false): ConsoleRun {
  const progress = (job.progress ?? {}) as Progress;
  const status: ConsoleRun['status'] = stopping ? 'running' : job.status === 'completed' ? 'completed'
    : job.status === 'cancelled' ? 'cancelled' : ['dead', 'failed', 'paused'].includes(job.status) ? 'failed'
    : job.status === 'active' ? 'running' : 'queued';
  const adapter = new TaskProgressAdapter(String(job.data.kind), progress.product);
  if (!progress.product) adapter.write(progress.output ?? '');
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
  private loop: Promise<void> | null = null;
  private stopped = false;
  private paused = false;
  private failure: Error | null = null;
  private cached: ConsoleRun[] = [];
  private executions = new Map<number, { cancel: () => void; done: Promise<unknown> }>();

  constructor(private engine: BrainEngine) {
    this.queue = new MinionQueue(engine);
    this.worker = new MinionWorker(engine, {
      queue: PRODUCT_TASK_QUEUE, concurrency: 1, pollInterval: 100,
      healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000,
    });
    this.worker.on('unhealthy', info => console.error('[tasks]', info));
    this.worker.register(TASK_NAME, job => this.execute(job));
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.queue.ensureSchema();
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
       error_text = '软件已退出，任务结果可能不完整。请查看已完成结果后手动继续；模型请求可能已产生费用。',
       finished_at = now(), updated_at = now()
       WHERE queue = $1 AND name = $2 AND status = 'active'
       AND ($3::boolean OR lock_until <= now())`, [PRODUCT_TASK_QUEUE, TASK_NAME, this.engine.kind === 'pglite'],
    );
    this.loop = this.worker.start().catch(error => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      console.error('[tasks] worker stopped:', error instanceof Error ? error.message : error);
    });
  }

  private async submit(task: ProductTask, kind: string, idempotencyKey?: string, trigger: 'manual' | 'scheduled' = 'manual'): Promise<ConsoleRun> {
    if (this.stopped || this.paused) throw new Error('数据库维护期间暂不能提交新任务');
    if (this.failure) throw this.failure;
    const job = await this.queue.add(TASK_NAME, { task, kind, trigger }, {
      queue: PRODUCT_TASK_QUEUE, max_attempts: 1,
      timeout_ms: task.input.timeoutMs ?? undefined,
      idempotency_key: idempotencyKey ?? `product:${randomUUID()}`,
    });
    return toRun(job);
  }

  async submitImport(input: ImportTaskInput): Promise<ConsoleRun> {
    if (!input.path.trim()) throw new Error('Path is required');
    const sourceId = await resolveImportSourceIdForPath(this.engine, input.path, input.sourceId);
    const file = await stat(input.path).catch(() => null);
    const key = `product-import:${createHash('sha256').update(JSON.stringify([input, sourceId, file?.size, file?.mtimeMs])).digest('hex')}`;
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET idempotency_key = NULL WHERE idempotency_key = $1
       AND status IN ('completed', 'dead', 'failed', 'cancelled', 'paused')`, [key],
    );
    return this.submit({ type: 'import', input: { ...input, path: input.path.trim(), sourceId, timeoutMs: input.timeoutMs ?? 6 * 60 * 60_000 } }, 'import_path', key);
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
    return this.submit({ type: 'dream', input }, `dream_${input.preset ?? (input.phase && input.phase !== 'all' ? input.phase : 'cycle')}`, undefined, trigger);
  }

  async submitEmbed(input: { catchUp?: boolean; forceReembed?: boolean } = {}): Promise<ConsoleRun> {
    return this.submit({ type: 'embed', input }, 'embed_stale');
  }

  async submitSync(): Promise<ConsoleRun> {
    return this.submit({ type: 'sync', input: {} }, 'sync_all');
  }

  async listRuns(): Promise<ConsoleRun[]> {
    this.cached = (await this.queue.getJobs({ queue: PRODUCT_TASK_QUEUE, name: TASK_NAME, limit: 100 }))
      .map(job => toRun(job, job.status === 'cancelled' && this.executions.has(job.id)));
    return this.cached;
  }

  cachedRuns(): ConsoleRun[] { return this.cached; }

  async getRun(id: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const job = await this.queue.getJob(Number(id.slice(5)));
    return job?.queue === PRODUCT_TASK_QUEUE && job.name === TASK_NAME
      ? toRun(job, job.status === 'cancelled' && this.executions.has(job.id)) : null;
  }

  async cancel(id: string): Promise<ConsoleRun | null> {
    const run = await this.getRun(id);
    if (!run || !['running', 'queued'].includes(run.status)) return run;
    const jobId = Number(id.slice(5));
    await this.queue.cancelJob(jobId);
    const execution = this.executions.get(jobId);
    execution?.cancel();
    await execution?.done;
    return this.getRun(id);
  }

  async retry(id: string): Promise<ConsoleRun | null> {
    const run = await this.getRun(id);
    if (!run) return null;
    if (!['failed', 'cancelled'].includes(run.status)) throw new Error('只有失败、中断或已取消的任务可以重新执行');
    const record = await this.queue.getJob(Number(id.slice(5)));
    const task = record!.data.task as ProductTask;
    if (task.type === 'import') {
      return this.submitImport({ ...task.input, resumeCheckpointId: Number(id.slice(5)) });
    }
    if (task.type === 'dream') return this.submitDream(task.input);
    if (task.type === 'sync') return this.submitSync();
    return this.submitEmbed(task.input);
  }

  private async execute(context: MinionJobContext): Promise<unknown> {
    if (this.stopped || this.paused) throw new Error('后台任务执行器已停止，任务未开始，请稍后重试');
    context.signal.throwIfAborted();
    context.shutdownSignal.throwIfAborted();
    const record = await this.queue.getJob(context.id);
    if (!record?.lock_token) throw new Error('任务执行租约无效');
    if (record.attempts_started > 1) throw new Error('任务执行曾中断，结果不确定，请查看已完成内容后手动继续');
    let progress = (record.progress ?? {}) as Progress;
    const adapter = new TaskProgressAdapter(String(record.data.kind), progress.product);
    let progressTail = Promise.resolve();
    const persist = () => {
      progress.product = adapter.view;
      const snapshot = structuredClone(progress);
      progressTail = progressTail.then(() => context.updateProgress(snapshot));
      return progressTail;
    };
    const host = new TaskEngineHost(this.engine, context.id, record.lock_token, async file => {
      await appendTaskCheckpoint(context.id, file);
      progress.files = [...(progress.files ?? []), file].slice(-100);
      await persist();
    });
    const workerPath = /\/(?:~BUN|\$bunfs)\//.test(decodeURIComponent(import.meta.url))
      ? './product/tasks/task-worker.ts'
      : new URL(import.meta.url.endsWith('.ts') ? './task-worker.ts' : './task-worker.js', import.meta.url);
    const thread = new Worker(workerPath, { env: { ...process.env } });
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    thread.once('exit', stop);
    let settleResolve!: (value: unknown) => void;
    let settleReject!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
    let cancelRequested = false;
    let completed = false;
    const cancel = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      thread.postMessage({ type: 'cancel' });
      settleReject(new Error('任务已取消'));
    };
    const finished = (async () => {
      try { return await result; }
      finally {
        thread.removeAllListeners('message');
        try { await host.close(); }
        finally {
          try {
            await thread.terminate();
            await stopped;
            await progressTail;
            const task = record.data.task as ProductTask;
            if (task.type === 'import' && task.input.stagingDir && completed) {
              await removeAdminUploadTempDir(task.input.stagingDir);
            }
          } finally { this.executions.delete(context.id); }
        }
      }
    })();
    this.executions.set(context.id, { cancel, done: finished.catch(() => {}) });
    context.signal.addEventListener('abort', cancel, { once: true });
    context.shutdownSignal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted || context.shutdownSignal.aborted) cancel();
    thread.once('error', error => settleReject(error instanceof Error ? error : new Error(String(error))));
    thread.once('exit', code => settleReject(new Error(`任务 Worker 意外退出（${code}）`)));
    thread.on('message', (message: TaskWorkerMessage) => {
      if (message.type === 'rpc') {
        void host.dispatch(message).then(value => {
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
      } else if (message.type === 'result') {
        completed = true;
        progress.result = message.result;
        void persist().then(() => settleResolve(message.result), settleReject);
      } else if (message.type === 'error') {
        progress.result = message.result;
        void persist().then(() => settleReject(new Error(message.error)), settleReject);
      }
    });
    const flush = setInterval(() => void persist().catch(settleReject), 1000);
    thread.postMessage({ type: 'start', kind: this.engine.kind, task: record.data.task });
    try { return await finished; }
    finally {
      clearInterval(flush);
      context.signal.removeEventListener('abort', cancel);
      context.shutdownSignal.removeEventListener('abort', cancel);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.worker.stop();
    const interrupted = [...this.executions.keys()];
    for (const execution of this.executions.values()) execution.cancel();
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    await this.loop;
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
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    await this.loop;
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    this.loop = null;
  }

  async resume(): Promise<void> {
    this.paused = false;
    this.failure = null;
    if (!this.stopped) await this.start();
  }
}
