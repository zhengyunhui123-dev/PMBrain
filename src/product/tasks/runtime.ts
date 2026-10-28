import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { stat, mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { isExpectedDatabaseInterruptReason } from '../../core/process-cleanup.ts';
import { MinionQueue } from '../../core/minions/queue.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import { MINION_DEFERRED, rowToMinionJob, type MinionJob, type MinionJobContext } from '../../core/minions/types.ts';
import type { ConsoleRun } from '../../commands/natural-lang/types.ts';
import { resolveImportSourceIdForPath } from '../../commands/natural-lang/api.ts';
import { ALL_PHASES } from '../../core/cycle.ts';
import { assertDreamPresetAllowGenerative, assertPhasesAllowGenerative } from '../../core/model-usage.ts';
import { TaskEngineHost } from './engine-host.ts';
import type { DreamTaskInput, ImportTaskInput, ProductTask, TaskWorkerMessage } from './types.ts';
import { removeAdminUploadTempDir } from '../../commands/pmbrain-admin-support.ts';
import { appendTaskCheckpoint, taskArtifactPath, resumeMaintenanceCheckpoint, retireAutomaticCapture, setMaintenanceCheckpoint } from './checkpoint.ts';
import { DEFAULT_PRODUCT_TASK_TIMEOUT_MS, DREAM_TASK_TIMEOUT_KEY, parseTaskTimeout } from './timeout.ts';
import { FileProjection } from './file-projection.ts';
import { WorkerPgliteEngine } from '../database/worker-engine.ts';
import { TaskProgressAdapter, finishTaskProgress,applyTaskBudget } from './progress-adapter.ts';
import { taskUsesFileQueue, usesSyncFileQueue, type DocumentOcrOverview, type TaskProductProgress } from '../../../shared/task-progress.ts';
import { withDatabasePriority } from '../database/priority';
import { SyncFileQueue, SYNC_FILE_QUEUE, SYNC_FILE_TASK } from './sync-file-queue.ts';
import type { MaintenanceCheckpoint, SyncFileInput } from './types.ts';
import { resolveSourceId } from '../../core/source-resolver.ts';
import { recordSyncedGitFile, commitQuickMaintenanceSource } from './synced-git.ts';
import type { SyncResult } from '../../commands/sync.ts';
import { maintenanceFailure } from './maintenance-orchestration.ts';
import { claimMaintenanceCapture } from './maintenance-orchestration.ts';
import {
  SEARCH_OPTIMIZE_JOB_KEY, SEARCH_OPTIMIZE_NOTICE, SEARCH_OPTIMIZE_PAUSED, assignSearchOptimizeAcceptance, vectorizationInterrupted, vectorizationRetryDelay,
  type SearchOptimizeAcceptance,
} from './search-optimize.ts';
import { enqueueCapturedSearchOptimize, enqueueSearchOptimize, completeSearchOptimize, loadSearchOptimize, pauseSearchOptimize } from './search-optimize-store.ts';
import { TaskResourceGuard, PRODUCT_QUEUE_CAPACITY, isSyncCapacityError, type TaskResourceOptions } from './resource-guard.ts';
import { WorkbenchMemoryCoordinator, memoryVersion, type WorkbenchMemoryTask } from '../workbench/memory';
import { WorkbenchStore } from '../workbench/store';
import { resolveWritebackConfig } from '../../core/facts/writeback-config';
import { loadConfigFileOnly } from '../../core/config';
import { withDatabaseRequest, withoutDatabaseRequest } from '../database/request-context.ts';
import { withDeadline } from '../deadline.ts';
import {handleTaskBudget,type TaskBudgetRequest,type TaskBudgetState} from './task-budget';
import { BackgroundVectorizationScheduler } from './background-vectorization';
import { documentResourcePlan } from '../../core/document/resource-policy';
import type { BackgroundResourceSample, VectorizationSchedule } from '../../../shared/background-vectorization';
import {DOCUMENT_OCR_TASK,DOCUMENT_OCR_QUEUE} from '../../core/pmbrain-adapters/deferred-document-ocr';

export const PRODUCT_TASK_QUEUE = 'pmbrain-product';
const TASK_NAME = 'pmbrain-product-task';
type Progress = { product?: TaskProductProgress; output?: string; result?: Record<string, unknown>; cancelRequested?: boolean; files?: Record<string, unknown>[] };

function toRun(job: MinionJob, stopping = false): ConsoleRun {
  const progress = (job.progress ?? {}) as Progress;
  const failure = job.status === 'completed' && String(job.data.kind).startsWith('dream_') ? maintenanceFailure(job.result ?? progress.result) : null;
  const adapter = new TaskProgressAdapter(String(job.data.kind), progress.product);
  if (!progress.product) adapter.write(progress.output ?? '');
  const task = job.data.task as ProductTask;
  const searchOptimize = task?.type === 'embed' && task.input.searchOptimize === true;
  const status: ConsoleRun['status'] = stopping ? 'running' : failure ? 'failed' : job.status === 'completed' ? 'completed'
    : job.status === 'cancelled' ? 'cancelled' : searchOptimize && job.status === 'paused' ? 'paused'
    : ['dead', 'failed', 'paused'].includes(job.status) ? 'failed'
    : ['active', 'waiting-children'].includes(job.status) ? 'running' : 'queued';
  adapter.view.relations = { available: Object.hasOwn(job.data, 'relations'), total: Object.keys((job.data.relations ?? {}) as object).length };
  adapter.view.gitResults = Object.values(job.data.gitResults ?? {});
  if (searchOptimize && status === 'running' && job.data.searchOptimizePause === 'manual') {
    adapter.view.stage = '正在暂停，当前批次保存后停止';
  }
  if(job.data.taskBudget){const {reservations,pendingPricing,...budget}=job.data.taskBudget as TaskBudgetState;adapter.view.budget=budget;}
  if (task?.type === 'import') adapter.view.material = { ...adapter.view.material,
    name: (task.input.ocrOnly?.relativePath??task.input.path).split(/[\\/]/).filter(Boolean).at(-1) ?? task.input.path,
    sourceId: task.input.sourceId ?? 'default', directory: task.input.directory === true,
  };
  return {
    product: finishTaskProgress(adapter.view, status, job.result ?? progress.result, failure ?? job.error_text, (job.finished_at ?? job.updated_at).getTime()),
    id: `task-${job.id}`, kind: String(job.data.kind), command: [], status,
    ...(searchOptimize ? { searchOptimize: true } : {}),
    trigger: job.data.trigger === 'scheduled' ? 'scheduled' : 'manual',
    stdout: progress.output ?? '', stderr: '', error: stopping ? '正在停止任务…' : failure ?? job.error_text,
    exitCode: status === 'completed' ? 0 : ['failed', 'cancelled'].includes(status) ? 1 : null,
    startedAt: (job.started_at ?? job.created_at).toISOString(),
    completedAt: job.finished_at?.toISOString() ?? null,
    durationMs: job.finished_at ? job.finished_at.getTime() - (job.started_at ?? job.created_at).getTime() : null,
    result: task?.type === 'assistant' ? { assistantId: task.input.assistantId, conversationId: task.input.conversationId, ...((job.result ?? progress.result) as Record<string, unknown> ?? {}) } : job.result ?? progress.result,
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
  private stopAcknowledgements = new Map<number, Promise<void>>();
  private stopIntents = new Set<number>();
  private fileProjection = new FileProjection();
  private recoveringOwner: Promise<void> | null = null;
  private dirtyFiles = new Map<number,Set<number>>();
  private idleFileThreads: Worker[] = [];
  private idleMaintenanceThreads: Worker[] = [];
  private sessionRefresh = new Map<number, { timer: ReturnType<typeof setTimeout>; file?: string }>();
  private loop: Promise<void> | null = null;
  private stopped = false;
  private paused = false;
  private failure: Error | null = null;
  private cached: ConsoleRun[] = [];
  private refreshingRuns: Promise<void> | null = null;
  private ocrOverviewCache: DocumentOcrOverview | null = null;
  private ocrOverviewRefreshing: Promise<void> | null = null;
  private ocrOverviewAt = 0;
  private ocrOverviewError: string | null = null;
  private executions = new Map<number, { background?: boolean; pause?: () => void; cancel: (reason?:string) => void; done: Promise<unknown>; run: () => ConsoleRun; ownsLockedTransaction: () => boolean; adjust:(constrained:boolean)=>void }>();
  private resources:TaskResourceGuard;
  private background: BackgroundVectorizationScheduler;
  private foregroundCheck?: () => boolean;
  private resourceDrain:Promise<void>|null=null;
  private resourceTimer:ReturnType<typeof setInterval>|null=null;
  private idleTimer:ReturnType<typeof setTimeout>|null=null;
  private localPressure=false;
  private externalPressure=false;
  private reclaiming:Promise<void>|null=null;
  private workbenchMemory?: WorkbenchMemoryCoordinator;
  private workbenchAssistant?: (input: import('../workbench/agent-tasks').WorkbenchAssistantTask, context: MinionJobContext) => Promise<unknown>;
  private closeWorkbenchAssistant?: () => void;
  attachWorkbenchAssistant(execute: NonNullable<ProductTaskRuntime['workbenchAssistant']>, close: () => void) {
    this.closeWorkbenchAssistant?.(); this.workbenchAssistant = execute; this.closeWorkbenchAssistant = close;
  }
  async submitAssistant(input: import('../workbench/agent-tasks').WorkbenchAssistantTask, key: string, scheduled = false) {
    return this.submit({ type: 'assistant', input }, 'assistant_task', key, scheduled ? 'scheduled' : 'manual');
  }
  attachWorkbenchMemory(store: WorkbenchStore) {
    this.workbenchMemory?.close();
    this.workbenchMemory = new WorkbenchMemoryCoordinator(this.engine, store, (input, key) => this.submitMemory(input, key), id => this.getRun(id));
    this.workbenchMemory.start();
    return this.workbenchMemory;
  }
  async submitMemory(input: WorkbenchMemoryTask, key?: string): Promise<ConsoleRun> {
    return this.submit({ type: 'memory', input }, 'conversation_memory', key, 'scheduled');
  }

  constructor(private engine: BrainEngine, resourceOptions:TaskResourceOptions={}) {
    this.resources=new TaskResourceGuard(resourceOptions);
    this.background=new BackgroundVectorizationScheduler(resourceOptions.background);
    this.fileProjection=new FileProjection({resources:this.resources});
    const memoryOptions={maxRssMb:0};
    this.queue = new MinionQueue(engine);
    this.fileQueue = new SyncFileQueue(engine,job=>this.fileProjection.record(job),id=>!this.stopIntents.has(id)&&!this.paused&&!this.stopped,this.resources);
    this.fileWorker = new MinionWorker(engine, { ...memoryOptions, queue: SYNC_FILE_QUEUE, concurrency: engine.kind==='pglite'?1:2, pollInterval: 100, healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000, ownsLockedTransaction: id => this.executions.get(id)?.ownsLockedTransaction() === true });
    this.fileWorker.on('job-finished', (job:MinionJob)=>{
      if(this.stopped||this.paused)return;
      if(job.name===DOCUMENT_OCR_TASK)return;
      void this.queue.getJob(job.id).then(async current=>{
        try{if(current){this.fileProjection.record(current);await this.fileQueue.cleanupCompleted(current);}}
        finally{this.scheduleSessionRefresh(Number(job.data.sessionId));}
      }).catch(error=>console.error('[tasks] file completion:',error));
    });
    this.fileWorker.register(SYNC_FILE_TASK, async context => {
      const sessionId = Number(context.data.sessionId);
      if (this.stopIntents.has(sessionId)) throw new Error('同步会话已停止');
      this.fileSessions.set(context.id, sessionId);
      this.fileProjection.pin(sessionId);
      if(!this.dirtyFiles.has(sessionId))this.dirtyFiles.set(sessionId,new Set());
      this.dirtyFiles.get(sessionId)!.add(context.id);
      try {
        const parent = await this.queue.getJob(sessionId);
        if (parent?.queue !== PRODUCT_TASK_QUEUE || parent.status !== 'waiting-children') throw new Error('同步会话已停止，文件尚未开始');
        this.scheduleSessionRefresh(sessionId, ((context.data.task as ProductTask).input as SyncFileInput).relativePath);
        return await withDatabasePriority(2, () => this.execute(context));
      } catch (error) {
        if (this.stopIntents.has(sessionId) || this.recoveringOwner) throw error;
        await this.fileQueue.pause(sessionId);
        for (const [id, owner] of this.fileSessions) if (owner === sessionId && id !== context.id) this.executions.get(id)?.cancel();
        await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', error_text = $2, lock_token = NULL, lock_until = NULL, updated_at = now() WHERE id = $1 AND status NOT IN ('completed','cancelled','dead','failed')`, [sessionId, error instanceof Error ? error.message : String(error)]);
        throw error;
      } finally {
        this.fileSessions.delete(context.id);
        if(![...this.fileSessions.values()].includes(sessionId))this.fileProjection.pin(sessionId,false);
        this.scheduleSessionRefresh(sessionId);
      }
    });
    this.fileWorker.register(DOCUMENT_OCR_TASK,context=>withDatabasePriority(3,()=>this.execute(context)));
    this.worker = new MinionWorker(engine, {
      ...memoryOptions, queue: PRODUCT_TASK_QUEUE, concurrency: engine.kind==='pglite'?1:2, pollInterval: 100,
      healthCheckInterval: 0, lockDuration: 30_000, stalledInterval: 5000,
      ownsLockedTransaction: id => this.executions.get(id)?.ownsLockedTransaction() === true,
    });
    this.worker.on('unhealthy', info => console.error('[tasks]', info));
    this.worker.register(TASK_NAME, job => withDatabasePriority((job.data.task as ProductTask).type === 'import' ? 2 : 3, () => this.execute(job)));
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.queue.ensureSchema();
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,updated_at=now(),
      error_text='旧版自动实体识别已停用，已保存结果保留；可明确范围后手动继续。'
      WHERE queue=$1 AND data->'task'->>'type'='dream' AND data->'task'->'input'->>'phase'='capture_entities'
      AND data->>'trigger' IS DISTINCT FROM 'manual' AND status IN ('waiting','active','waiting-children','delayed')
      AND (status<>'active' OR $2::boolean OR lock_until IS NULL OR lock_until<=now())`, [PRODUCT_TASK_QUEUE,this.engine.kind==='pglite']);
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='waiting',lock_token=NULL,lock_until=NULL,error_text=NULL,updated_at=now()
      WHERE queue=$1 AND data->'task'->>'type'='memory' AND ((status='paused' AND data->>'resumeOnRestart'='true') OR (status='active' AND ($2::boolean OR lock_until<=now())))`, [PRODUCT_TASK_QUEUE,this.engine.kind==='pglite']);
    await this.engine.executeRaw(`UPDATE minion_jobs AS child SET parent_job_id=parent.id
      FROM minion_jobs AS parent WHERE child.queue=$1 AND child.parent_job_id IS NULL
      AND child.data->>'sessionId'=parent.id::text AND parent.queue=$2`,[SYNC_FILE_QUEUE,PRODUCT_TASK_QUEUE]);
    await this.loadStopIntents();
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='waiting',lock_token=NULL,lock_until=NULL,error_text=NULL,updated_at=now()
      WHERE queue=$1 AND name=$2 AND NOT (id=ANY($3::int[])) AND ((status='active' AND ($4::boolean OR lock_until<=now())) OR (status IN ('failed','dead','paused') AND (error_text LIKE '%service_shutdown%' OR error_text LIKE '%本地服务关闭%')))`,[DOCUMENT_OCR_QUEUE,DOCUMENT_OCR_TASK,[...this.stopIntents],this.engine.kind==='pglite']);
    const committed=await this.engine.executeRaw<{parent_job_id:number|null}>(`UPDATE minion_jobs AS child SET status='completed',lock_token=NULL,lock_until=NULL,finished_at=now(),updated_at=now()
      WHERE child.queue=$1 AND child.status='active' AND ($2::boolean OR child.lock_until<=now())
      AND child.result->>'status' IN ('imported','skipped') AND EXISTS(SELECT 1 FROM pages p
        WHERE p.slug=child.result->>'slug' AND p.source_id=child.data->'task'->'input'->'options'->>'sourceId'
        AND p.deleted_at IS NULL AND p.chunker_version>=0 AND p.content_hash=child.result->>'pageHash'
        AND (child.result->>'status'='skipped' OR (SELECT count(*) FROM content_chunks WHERE page_id=p.id)=(child.result->>'chunks')::bigint))
      RETURNING parent_job_id`,[SYNC_FILE_QUEUE,this.engine.kind==='pglite']);
    for(const id of new Set(committed.map(row=>row.parent_job_id).filter((id):id is number=>id!==null)))await this.queue.resolveParent(id);
    await this.fileQueue.cleanupCompletedSnapshots().catch(error => console.error('[tasks] snapshot recovery cleanup:', error));
    await this.fileQueue.cleanupStoppedSnapshots().catch(error => console.error('[tasks] stopped snapshot cleanup:', error));
    await this.recoverSessions();
    await this.recoverCapacitySessions();
    await this.queue.handleStalled([],SYNC_FILE_QUEUE);
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET status = 'paused', lock_token = NULL, lock_until = NULL,
       error_text = '软件已退出，任务结果可能不完整。请查看已完成结果后手动继续；模型请求可能已产生费用。',
       finished_at = now(), updated_at = now()
       WHERE queue = $1 AND name = $2 AND status = 'active' AND data->'task'->'input'->>'preset' IS DISTINCT FROM 'quick' AND data->>'fileSession' IS DISTINCT FROM 'true'
       AND NOT (data->'task'->>'type' = 'embed' AND data->'task'->'input'->>'searchOptimize' = 'true')
       AND ($3::boolean OR lock_until <= now())`, [PRODUCT_TASK_QUEUE, TASK_NAME, this.engine.kind === 'pglite'],
    );
    await this.recoverSearchOptimize();
    await this.recoverInterruptedImports();
    await this.listRuns();
    for (const run of this.cached.filter(run=>taskUsesFileQueue(run.kind))) await this.fileProjection.load(Number(run.id.slice(5)));
    await this.hydrateFiles(this.cached.filter(run=>taskUsesFileQueue(run.kind)).map(run=>Number(run.id.slice(5))));
    this.fileLoop = withDatabasePriority(2, () => this.fileWorker.start()).catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); console.error('[tasks] file worker stopped:', error); });
    this.loop = withDatabasePriority(3, () => this.worker.start()).catch(error => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      console.error('[tasks] worker stopped:', error instanceof Error ? error.message : error);
    });
    if(this.resourceTimer)clearInterval(this.resourceTimer);
    this.resourceTimer=setInterval(()=>{this.checkMemory();void this.resumeInterruptedSearchOptimize().catch(error=>console.error('[tasks] search optimize resume:',error instanceof Error?error.message:error));},this.resources.rssCheckIntervalMs);
    this.resourceTimer.unref();
  }

  private async submit(task: ProductTask, kind: string, idempotencyKey?: string, trigger: 'manual' | 'scheduled' = 'manual', queue = this.queue): Promise<ConsoleRun> {
    if (this.failure) throw this.failure;
    this.checkMemory();
    if (this.failure) throw this.failure;
    if (this.stopped || this.paused) throw new Error('数据库维护期间暂不能提交新任务');
    await this.resources.assertImportDisk();
    const job = await queue.add(TASK_NAME, { task, kind, trigger, relations: {}, fileSession: task.type === 'dream' && usesSyncFileQueue(task.input) }, {
      queue: PRODUCT_TASK_QUEUE, max_attempts: 1, maxQueueSize: PRODUCT_QUEUE_CAPACITY,
      timeout_ms: task.input.timeoutMs ?? DEFAULT_PRODUCT_TASK_TIMEOUT_MS,
      idempotency_key: idempotencyKey ?? `product:${randomUUID()}`,
    });
    const run = toRun(job);
    if(task.type === 'dream' && usesSyncFileQueue(task.input))this.fileProjection.seed(job.id,[]);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 120);
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
    if(input.timeoutMs!==undefined&&parseTaskTimeout(input.timeoutMs)===null)throw new Error('任务超时必须是有效的正整数毫秒数');
    const timeoutMs=input.timeoutMs??parseTaskTimeout(await this.engine.getConfig(DREAM_TASK_TIMEOUT_KEY))??DEFAULT_PRODUCT_TASK_TIMEOUT_MS;
    return this.submit({ type: 'import', input: { ...input, directory: file?.isDirectory() ?? false, path: input.path.trim(), sourceId, timeoutMs } }, 'import_path', key);
  }

  async submitDream(input: DreamTaskInput, trigger: 'manual' | 'scheduled' = 'manual'): Promise<ConsoleRun> {
    if (input.timeoutMs !== undefined && parseTaskTimeout(input.timeoutMs) === null) throw new Error('任务超时必须是有效的正整数毫秒数');
    input = { ...input, incrementalIngest:true, timeoutMs: input.timeoutMs ?? parseTaskTimeout(await this.engine.getConfig(DREAM_TASK_TIMEOUT_KEY)) ?? DEFAULT_PRODUCT_TASK_TIMEOUT_MS };
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
          AND status IN ('waiting','active','waiting-children','delayed') AND ($3::boolean OR data->'task'->'input'->>'allSources' = 'true'
            OR COALESCE(data->'task'->'input'->>'sourceId', 'default') = $4) LIMIT 1`, [PRODUCT_TASK_QUEUE, TASK_NAME, input.allSources === true, sourceId ?? 'default']);
        if (existing.length) return toRun((await new MinionQueue(tx).getJob(existing[0].id))!);
        const scoped = Object.create(tx) as BrainEngine;
        scoped.transaction = async fn => fn(tx);
        return this.submit({ type: 'dream', input: { ...input, sourceId } }, 'dream_quick', undefined, trigger, new MinionQueue(scoped));
      });
    }
    return this.submit({ type: 'dream', input }, `dream_${input.preset ?? (input.phase && input.phase !== 'all' ? input.phase : 'cycle')}`, undefined, trigger);
  }

  async submitEmbed(input: { catchUp?: boolean; forceReembed?: boolean; sourceId?: string; slugs?: string[] } = {}): Promise<ConsoleRun> {
    const slugs = input.slugs?.map(slug => slug.trim()).filter(slug => slug.length > 0 && !slug.includes(':'));
    return this.submit({ type: 'embed', input: { ...input, slugs: slugs?.length ? slugs : undefined } }, 'embed_stale');
  }

  private async queueDeferredImportVectors(task: ProductTask, payload: Record<string, unknown> | undefined, cancelled: boolean): Promise<void> {
    if (cancelled || task.type !== 'import' || task.input.noEmbed === true || !payload || payload.searchOptimizeAccepted === true) return;
    const slugs = Array.isArray(payload.embedSlugs) ? payload.embedSlugs.filter((slug): slug is string => typeof slug === 'string' && slug.length > 0 && !slug.includes(':')) : [];
    if (!slugs.length) return;
    const sourceId = typeof payload.embedSourceId === 'string' ? payload.embedSourceId : task.input.sourceId ?? 'default';
    try {
      assignSearchOptimizeAcceptance(payload, await this.acceptSearchOptimize(sourceId, slugs));
    } catch (error) {
      console.error('[tasks] deferred embed:', error);
      payload.searchOptimizeError = true;
      delete payload.vectorsPending;
      delete payload.searchOptimizeAccepted;
    }
  }

  private searchOptimizeTask(job: MinionJob | null | undefined): boolean {
    const task = job?.data.task as ProductTask | undefined;
    return job?.queue === PRODUCT_TASK_QUEUE && job.name === TASK_NAME && task?.type === 'embed' && task.input.searchOptimize === true;
  }

  private async findSearchOptimizeJob(): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE idempotency_key = $1 ORDER BY id DESC LIMIT 1`, [SEARCH_OPTIMIZE_JOB_KEY]);
    return rows.length ? this.queue.getJob(rows[0].id) : null;
  }

  private async parkSearchOptimize(id: number): Promise<void> {
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused', lock_token=NULL, lock_until=NULL,
      error_text=$2, finished_at=COALESCE(finished_at, now()), updated_at=now(),
      data=jsonb_set(data, '{searchOptimizePause}', '"manual"'::jsonb)
      WHERE id=$1 AND status IN ('waiting','delayed')`, [id, SEARCH_OPTIMIZE_PAUSED]);
  }

  private async ensureSearchOptimizeJob(): Promise<{ job: MinionJob | null; queued: boolean; error?: string; notice?: string }> {
    const state = await loadSearchOptimize(this.engine);
    let job = await this.findSearchOptimizeJob();
    if (job && ['completed', 'cancelled'].includes(job.status)) {
      await this.engine.executeRaw(`UPDATE minion_jobs SET idempotency_key = NULL WHERE id = $1 AND idempotency_key = $2`, [job.id, SEARCH_OPTIMIZE_JOB_KEY]);
      job = null;
    }
    if (state.paused) {
      if (!state.items.length) return { job, queued: false };
      if (job && ['waiting', 'active', 'paused', 'delayed', 'waiting-children'].includes(job.status)) {
        if (['waiting', 'delayed'].includes(job.status)) await this.parkSearchOptimize(job.id);
        return { job: await this.queue.getJob(job.id), queued: false };
      }
      if (job && ['failed', 'dead'].includes(job.status)) return { job, queued: false, notice: SEARCH_OPTIMIZE_NOTICE };
      try {
        const run = await this.submit({ type: 'embed', input: { searchOptimize: true, catchUp: true } }, 'embed_stale', SEARCH_OPTIMIZE_JOB_KEY);
        const created = Number(run.id.slice(5));
        await this.parkSearchOptimize(created);
        return { job: await this.queue.getJob(created), queued: false };
      } catch (error) {
        return { job, queued: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!state.items.length) return { job, queued: false };
    if (job && ['waiting', 'active', 'delayed', 'waiting-children'].includes(job.status)) return { job, queued: true };
    const interrupted = job?.error_text ?? '';
    const shutdown = /service_shutdown|本地服务关闭|软件退出|软件已退出/.test(interrupted);
    if (job && (job.status === 'paused' || (['failed', 'dead'].includes(job.status) && shutdown))) {
      try {
        await this.retry(`task-${job.id}`);
        return { job: await this.queue.getJob(job.id), queued: true };
      } catch (error) {
        return { job, queued: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (job && ['failed', 'dead'].includes(job.status)) {
      const count = Number(job.data.vectorRetryCount ?? 0);
      const delay = vectorizationRetryDelay(job.error_text ?? '', count);
      if (delay !== null || vectorizationInterrupted(job.error_text ?? '')) {
        await this.clearStopIntent(job.id);
        const progress = (job.progress ?? {}) as Progress;
        delete progress.result;
        const adapter = new TaskProgressAdapter('embed_stale', progress.product);
        const retrying = delay !== null;
        adapter.view.background = { mode: 'waiting', reason: retrying ? '向量服务暂时不可用，稍后自动重试' : '等待空闲后继续知识向量化' };
        adapter.view.stage = adapter.view.background.reason;
        adapter.view.errorReason = null;
        adapter.view.detail = retrying ? job.error_text : null;
        progress.product = adapter.view;
        await this.engine.executeRaw(`UPDATE minion_jobs SET status='delayed',result=NULL,error_text=NULL,finished_at=NULL,
          lock_token=NULL,lock_until=NULL,delay_until=now()+($2::double precision * interval '1 millisecond'),progress=$3::jsonb,
          data=jsonb_set(data,'{vectorRetryCount}',$4::jsonb),updated_at=now() WHERE id=$1 AND status IN ('failed','dead')`, [job.id, delay ?? 250, progress, retrying ? count + 1 : count]);
        return { job: await this.queue.getJob(job.id), queued: true };
      }
      return { job, queued: false, notice: SEARCH_OPTIMIZE_NOTICE };
    }
    try {
      const run = await this.submit({ type: 'embed', input: { searchOptimize: true, catchUp: true } }, 'embed_stale', SEARCH_OPTIMIZE_JOB_KEY);
      return { job: await this.queue.getJob(Number(run.id.slice(5))), queued: true };
    } catch (error) {
      return { job: null, queued: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async resumeInterruptedSearchOptimize(): Promise<void> {
    if (this.stopped || this.paused || this.failure) return;
    const state = await loadSearchOptimize(this.engine);
    if (state.paused || !state.items.length) return;
    const job = await this.findSearchOptimizeJob();
    if (!job || !['failed', 'dead'].includes(job.status) || !vectorizationInterrupted(job.error_text ?? '')) return;
    await this.ensureSearchOptimizeJob();
  }

  private async recoverSearchOptimize(): Promise<void> {
    const state = await loadSearchOptimize(this.engine);
    const pglite = this.engine.kind === 'pglite';
    const shutdown = `(COALESCE(error_text, '') LIKE '%service_shutdown%' OR COALESCE(error_text, '') LIKE '%本地服务关闭%' OR COALESCE(error_text, '') LIKE '%软件退出%' OR COALESCE(error_text, '') LIKE '%软件已退出%')`;
    if (state.paused) {
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused', lock_token=NULL, lock_until=NULL,
        error_text=$2, finished_at=COALESCE(finished_at, now()), updated_at=now(),
        data=jsonb_set(data, '{searchOptimizePause}', '"manual"'::jsonb)
        WHERE queue=$1 AND name=$3 AND data->'task'->>'type'='embed' AND data->'task'->'input'->>'searchOptimize'='true'
        AND (status IN ('waiting','delayed','waiting-children')
          OR (status='active' AND ($4::boolean OR lock_until IS NULL OR lock_until<=now()))
          OR (status IN ('failed','dead') AND ${shutdown}))`, [PRODUCT_TASK_QUEUE, SEARCH_OPTIMIZE_PAUSED, TASK_NAME, pglite]);
      if (state.items.length) await this.ensureSearchOptimizeJob().catch(error => console.error('[tasks] search optimize:', error));
      return;
    }
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='waiting', lock_token=NULL, lock_until=NULL,
      error_text=NULL, finished_at=NULL, updated_at=now(), data=data-'searchOptimizePause'
      WHERE queue=$1 AND name=$2 AND data->'task'->>'type'='embed' AND data->'task'->'input'->>'searchOptimize'='true'
      AND (status='paused' OR (status='active' AND ($3::boolean OR lock_until IS NULL OR lock_until<=now()))
        OR (status IN ('failed','dead') AND ${shutdown}))`, [PRODUCT_TASK_QUEUE, TASK_NAME, pglite]);
    if (state.items.length) await this.ensureSearchOptimizeJob().catch(error => console.error('[tasks] search optimize:', error));
  }

  private async recoverInterruptedImports(): Promise<void> {
    const jobs = await this.engine.executeRaw<{ id: number; attempts: string | null }>(`SELECT id,data->>'databaseRecoveryAttempts' AS attempts FROM minion_jobs
      WHERE queue=$1 AND name=$2 AND status='paused' AND data->'task'->>'type'='import'
      AND error_text='数据库执行曾中断，请查看已完成资料后手动继续。' ORDER BY id LIMIT 100`, [PRODUCT_TASK_QUEUE, TASK_NAME]);
    for (const job of jobs) {
      const attempts = Number(job.attempts ?? 0);
      if (this.stopIntents.has(job.id) || !Number.isFinite(attempts) || attempts >= 2) continue;
      await this.engine.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{databaseRecoveryAttempts}',$2::jsonb) WHERE id=$1 AND status='paused'`, [job.id, attempts + 1]);
      await this.retry(`task-${job.id}`).catch(error => console.error('[tasks] import recovery:', error));
    }
  }

  async acceptSearchOptimize(sourceId: string, slugs: string[]): Promise<SearchOptimizeAcceptance> {
    const state = await enqueueSearchOptimize(this.engine, sourceId, slugs);
    const ensured = await this.ensureSearchOptimizeJob().catch(error => ({ job: null, queued: false, error: error instanceof Error ? error.message : String(error), notice: undefined }));
    return {
      paused: state.paused,
      queued: ensured.queued && !state.paused,
      jobId: ensured.job?.id ?? null,
      pending: state.pending,
      done: state.done,
      total: state.done + state.pending,
      ...(ensured.error ? { error: ensured.error } : {}),
      ...(ensured.notice ? { notice: ensured.notice } : {}),
    };
  }

  async pauseSearchOptimize(id: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const record = await this.queue.getJob(Number(id.slice(5)));
    if (!this.searchOptimizeTask(record)) return null;
    await pauseSearchOptimize(this.engine, true);
    if (record && ['waiting', 'delayed'].includes(record.status)) await this.parkSearchOptimize(record.id);
    if (record?.status === 'active') {
      await this.engine.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{searchOptimizePause}','"manual"'::jsonb) WHERE id=$1 AND status='active'`, [record.id]);
      this.executions.get(record.id)?.pause?.();
    }
    return this.getRun(id);
  }

  async continueSearchOptimize(id: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const record = await this.queue.getJob(Number(id.slice(5)));
    if (!this.searchOptimizeTask(record)) return null;
    await pauseSearchOptimize(this.engine, false);
    await this.engine.executeRaw(`UPDATE minion_jobs SET data = data - 'searchOptimizePause' - 'vectorRetryCount' WHERE id = $1`, [record!.id]);
    if (['paused', 'failed', 'dead', 'cancelled'].includes(record!.status)) return this.retry(id);
    if (['waiting', 'active', 'delayed', 'waiting-children'].includes(record!.status)) return this.getRun(id);
    await this.ensureSearchOptimizeJob();
    const current = await this.findSearchOptimizeJob();
    return this.getRun(current ? `task-${current.id}` : id);
  }

  private async searchOptimizeView() {
    const state = await loadSearchOptimize(this.engine);
    return { paused: state.paused, done: state.done, items: state.items, total: state.done + state.pending, schedule: await this.vectorizationDecision() };
  }

  noteActivity() { this.background.noteActivity(); }
  beginForeground() { return this.background.beginForeground(); }
  attachForegroundCheck(check: () => boolean) { this.foregroundCheck = check; }
  updateBackgroundResources(sample: Omit<BackgroundResourceSample, 'cpuBusyRatio'>) { this.background.updateDesktopSample(sample); }

  private async vectorizationDecision(maintenanceId?:number): Promise<VectorizationSchedule> {
    const decision = this.background.decision(this.foregroundCheck?.() === true, this.localPressure || this.externalPressure);
    if (decision.mode === 'waiting') return decision;
    const busy = await this.engine.executeRaw(`SELECT id FROM minion_jobs WHERE queue IN ($1,$2)
      AND status IN ('waiting','active','waiting-children')
      AND data->'task'->>'type' IN ('import','sync','sync-file','dream','assistant')
      AND (data->'task'->'input'->'ocrOnly' IS NULL OR status='active')
      AND data->>'waitingForOcr' IS DISTINCT FROM 'true'
      AND ($3::bigint IS NULL OR (id<>$3 AND (data->'task'->>'type'<>'dream' OR id<$3))) LIMIT 1`, [PRODUCT_TASK_QUEUE, SYNC_FILE_QUEUE,maintenanceId??null]);
    return this.background.decision(busy.length > 0, this.localPressure || this.externalPressure);
  }

  async submitSync(): Promise<ConsoleRun> {
    return this.submit({ type: 'sync', input: {} }, 'sync_all');
  }

  async files(id: string, after = 0): Promise<import('../../../shared/task-progress.ts').SyncFileDetails | null> {
    if (!/^task-\d+$/.test(id) || !Number.isSafeInteger(after) || after < 0) return null;
    const projected=this.fileProjection.details(Number(id.slice(5)),after);
    if (projected) return projected;
    if (this.executions.size || this.recoveringOwner) return null;
    const parent = await this.queue.getJob(Number(id.slice(5)));
    if (parent?.queue !== PRODUCT_TASK_QUEUE || parent.name !== TASK_NAME) return null;
    await this.hydrateFiles([parent.id]);
    return this.fileProjection.details(parent.id,after);
  }

  async listRuns(): Promise<ConsoleRun[]> {
    if (this.recoveringOwner) return this.cachedRuns();
    if (this.executions.size) {
      if (!this.refreshingRuns) {
        this.refreshingRuns = withDatabasePriority(3, () => this.historyJobs())
          .then(jobs => { this.cached = jobs.map(job => toRun(job)); })
          .catch(error => console.error('[tasks] history read failed:', error instanceof Error ? error.message : error))
          .finally(() => { this.refreshingRuns = null; });
      }
      return this.cachedRuns();
    }
    this.cached = (await this.historyJobs())
      .map(job => toRun(job, job.status === 'cancelled' && this.executions.has(job.id)));
    return this.cached;
  }

  async documentOcrOverview(): Promise<DocumentOcrOverview> {
    const [row]=await this.engine.executeRaw<{total:number;queued:number;running:number;completed:number;failed:number;cancelled:number;latest_at:Date|string|null;latest_completed_at:Date|string|null}>(`SELECT count(*)::int total,
      count(*) FILTER (WHERE status IN ('waiting','delayed'))::int queued,
      count(*) FILTER (WHERE status IN ('active','waiting-children'))::int running,
      count(*) FILTER (WHERE status='completed')::int completed,
      count(*) FILTER (WHERE status IN ('failed','dead','paused'))::int failed,
      count(*) FILTER (WHERE status='cancelled')::int cancelled,
      max(created_at) latest_at,max(finished_at) FILTER (WHERE status='completed') latest_completed_at FROM minion_jobs WHERE queue=$1 AND name=$2`,[DOCUMENT_OCR_QUEUE,DOCUMENT_OCR_TASK]);
    return {total:Number(row.total),queued:Number(row.queued),running:Number(row.running),completed:Number(row.completed),failed:Number(row.failed),cancelled:Number(row.cancelled),latestAt:row.latest_at?new Date(row.latest_at).toISOString():null,latestCompletedAt:row.latest_completed_at?new Date(row.latest_completed_at).toISOString():null};
  }

  cachedDocumentOcrOverview(): DocumentOcrOverview | null { return this.ocrOverviewCache; }
  cachedDocumentOcrError(): string | null { return this.ocrOverviewError; }

  refreshDocumentOcrOverview(): void {
    if(this.stopped||this.recoveringOwner||this.ocrOverviewRefreshing||Date.now()-this.ocrOverviewAt<5000)return;
    this.ocrOverviewRefreshing=withDatabasePriority(3,()=>this.documentOcrOverview())
      .then(overview=>{this.ocrOverviewCache=overview;this.ocrOverviewError=null;this.ocrOverviewAt=Date.now();})
      .catch(error=>{this.ocrOverviewError=error instanceof Error?error.message:String(error);this.ocrOverviewAt=Date.now();console.error('[tasks] OCR overview:',this.ocrOverviewError);})
      .finally(()=>{this.ocrOverviewRefreshing=null;});
  }

  async documentOcrRuns(options:{before?:number|null;limit?:number}={}):Promise<{rows:ConsoleRun[];next:number|null}>{
    const before=options.before??null,limit=options.limit??50;
    if(before!==null&&(!Number.isSafeInteger(before)||before<=0)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('无效的识图任务分页');
    const rows=await this.engine.executeRaw<Record<string,unknown>>(`SELECT * FROM minion_jobs WHERE queue=$1 AND name=$2 AND ($3::bigint IS NULL OR id<$3) ORDER BY id DESC LIMIT $4`,[DOCUMENT_OCR_QUEUE,DOCUMENT_OCR_TASK,before,limit+1]);
    const jobs=rows.map(rowToMinionJob),selected=jobs.slice(0,limit);
    return {rows:selected.map(job=>this.executions.get(job.id)?.run()??toRun(job)),next:jobs.length>limit?selected.at(-1)!.id:null};
  }

  private async historyJobs(){
    const [ordinary,ocr]=await Promise.all([this.queue.getJobs({queue:PRODUCT_TASK_QUEUE,name:TASK_NAME,limit:100}),this.queue.getJobs({queue:DOCUMENT_OCR_QUEUE,name:DOCUMENT_OCR_TASK,limit:20})]);
    return this.refreshOcrProgress([...ordinary,...ocr].sort((a,b)=>b.created_at.getTime()-a.created_at.getTime()));
  }
  private async refreshOcrProgress(jobs:MinionJob[]){
    const ids=[...new Set(jobs.flatMap(job=>Array.isArray(job.result?.ocrTaskIds)?job.result.ocrTaskIds as number[]:[]))];
    if(!ids.length)return jobs;
    const rows=await this.engine.executeRaw<{id:number;status:string;pending:number}>(`SELECT j.id,j.status,CASE WHEN j.status='completed' THEN 0 ELSE GREATEST(COALESCE((p.frontmatter->>'document_ocr_failed')::int,0)+COALESCE((p.frontmatter->>'document_ocr_skipped')::int,0),1) END pending
      FROM minion_jobs j LEFT JOIN pages p ON p.slug=j.data->'task'->'input'->'ocrOnly'->>'slug' AND p.source_id=j.data->'task'->'input'->>'sourceId' AND p.frontmatter->>'raw_sha256'=j.data->'task'->'input'->'ocrOnly'->>'hash' AND p.deleted_at IS NULL WHERE j.id=ANY($1::int[])`,[ids]);
    const states=new Map(rows.map(row=>[row.id,row]));
    return jobs.map(job=>{
      if(!Array.isArray(job.result?.ocrTaskIds))return job;
      const selected=(job.result.ocrTaskIds as number[]).map(id=>states.get(id));
      return {...job,result:{...job.result,ocrPending:selected.reduce((sum,row)=>sum+(row?.pending??1),0),ocrFailed:selected.filter(row=>!row||['failed','dead','paused','cancelled'].includes(row.status)).length}};
    });
  }

  cachedRuns(): ConsoleRun[] {
    const live = [...this.executions.entries()].map(([id,execution]) => this.stopIntents.has(id)?this.sessionViews.get(id)??execution.run():execution.run()).filter(run => run.kind !== 'sync_file');
    live.push(...[...this.sessionViews.values()].filter(run => !live.some(row => row.id === run.id)
      && (this.stoppingSessions.has(Number(run.id.slice(5))) || !this.cached.some(row=>row.id===run.id && ['completed','cancelled'].includes(row.status)))));
    for (const run of live) {
      const saved = this.cached.find(item=>item.id===run.id)?.product;
      if(run.product && saved) {run.product.relations=saved.relations;run.product.gitResults=saved.gitResults;if(saved.budget&&(saved.budget.revision??0)>(run.product.budget?.revision??0))applyTaskBudget(run.product,saved.budget);}
    }
    for (const run of live) if (run.product && taskUsesFileQueue(run.kind)) run.product.activeFiles = this.fileProjection.active(Number(run.id.slice(5)));
    return [...live, ...this.cached.filter(row => !live.some(run => run.id === row.id))]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 120);
  }

  async getRun(id: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const stopping = this.sessionViews.get(Number(id.slice(5)));
    if (stopping && this.stopIntents.has(Number(id.slice(5)))) return stopping;
    const execution = this.executions.get(Number(id.slice(5)));
    if (execution) {
      const live = execution.run();
      if (!this.refreshingRuns) {
        this.refreshingRuns = withDatabasePriority(3, () => this.queue.getJob(Number(id.slice(5))))
          .then(job => { if (job) this.cached = [toRun(job), ...this.cached.filter(run => run.id !== id)].slice(0,120); })
          .catch(error => console.error('[tasks] status read failed:', error instanceof Error ? error.message : error))
          .finally(() => { this.refreshingRuns = null; });
      }
      const saved = this.cached.find(run => run.id === id)?.product;
      if (saved && live.product) { live.product.relations=saved.relations; live.product.gitResults=saved.gitResults;if(saved.budget&&(saved.budget.revision??0)>(live.product.budget?.revision??0))applyTaskBudget(live.product,saved.budget); }
      return live;
    }
    const session = this.sessionViews.get(Number(id.slice(5)));
    if (session && (this.stoppingSessions.has(Number(id.slice(5))) || session.status==='failed'
      || (['running','queued'].includes(session.status) && [...this.fileSessions.values()].includes(Number(id.slice(5)))))) {
      if(session.product)session.product.activeFiles=this.fileProjection.active(Number(id.slice(5)));
      return session;
    }
    if (this.recoveringOwner) return this.cachedRuns().find(run => run.id === id) ?? null;
    const job = await this.queue.getJob(Number(id.slice(5)));
    if (!job||!(job.queue===PRODUCT_TASK_QUEUE&&job.name===TASK_NAME||job.queue===DOCUMENT_OCR_QUEUE&&job.name===DOCUMENT_OCR_TASK)) return null;
    const [resolved]=await this.refreshOcrProgress([job]);
    const run = toRun(resolved, job.status === 'cancelled' && this.executions.has(job.id));
    if(!['running','queued'].includes(run.status))this.sessionViews.delete(job.id);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 120);
    return run;
  }

  async cancel(id: string): Promise<ConsoleRun | null> {
    const run = await this.requestCancel(id);
    if (!run) return null;
    const jobId = Number(id.slice(5));
    await this.stoppingSessions.get(jobId);
    return this.sessionViews.get(jobId) ?? this.getRun(id);
  }

  async requestCancel(id: string, reason?: string): Promise<ConsoleRun | null> {
    if (!/^task-\d+$/.test(id)) return null;
    const jobId = Number(id.slice(5));
    if (this.stopAcknowledgements.has(jobId)) {
      this.executions.get(jobId)?.cancel(reason);
      for (const [child, owner] of this.fileSessions) if (owner === jobId) this.executions.get(child)?.cancel(reason);
      await this.stopAcknowledgements.get(jobId);
      return this.sessionViews.get(jobId) ?? this.cached.find(run => run.id === id) ?? null;
    }
    const view = this.executions.get(jobId)?.run() ?? this.sessionViews.get(jobId)
      ?? this.cached.find(run => run.id === id)
      ?? await withDeadline(this.getRun(id), 1000, '数据库未及时响应，无法确认该任务的状态');
    if (!view || !['running','queued'].includes(view.status)) return view;
    this.stopIntents.add(jobId);
    this.executions.get(jobId)?.cancel(reason);
    for (const [child, owner] of this.fileSessions) if (owner === jobId) this.executions.get(child)?.cancel(reason);
    this.sessionViews.set(jobId, { ...view, status: 'running', error: '正在停止任务…' });
    const acknowledgement = this.persistStopIntent(jobId, reason);
    this.stopAcknowledgements.set(jobId, acknowledgement);
    const pending = this.stopSession(jobId, view, acknowledgement, reason).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.sessionViews.set(jobId, { ...view, status: 'failed', error: message,
        product: view.product ? { ...view.product, activeFiles: [], errorReason: message, stage: '停止未完成' } : undefined });
      throw error;
    }).finally(() => { this.stoppingSessions.delete(jobId); });
    this.stoppingSessions.set(jobId, pending);
    void pending.catch(error => console.error('[tasks] stop:', error instanceof Error ? error.message : String(error)));
    await acknowledgement;
    return this.sessionViews.get(jobId)!;
  }

  async retry(id: string): Promise<ConsoleRun | null> {
    if(this.failure)throw this.failure;
    if(this.paused)throw new Error('后台执行器已暂停，请恢复服务后继续任务');
    await this.resources.assertImportDisk();
    await this.fileProjection.recover();
    const run = await this.getRun(id);
    if (!run) return null;
    const record = await this.queue.getJob(Number(id.slice(5)));
    const task = record!.data.task as ProductTask;
    const searchOptimize = task?.type === 'embed' && task.input.searchOptimize === true;
    if (!['failed', 'cancelled'].includes(run.status) && !(searchOptimize && ['paused', 'failed', 'dead'].includes(record!.status)) && !((taskUsesFileQueue(run.kind) || run.kind === 'dream_capture_entities' || run.kind==='import_path') && (run.result as Record<string, unknown> | undefined)?.status === 'partial')) throw new Error('只有失败、中断或已取消的任务可以重新执行');
    if (task.type === 'dream') {
      if (task.input.phase === 'capture_entities') record!.data.trigger = 'manual';
      else if (task.input.checkpoint && !task.input.incrementalIngest) {retireAutomaticCapture(task.input.checkpoint);task.input.incrementalIngest=true;}
    }
    const resumedId = Number(id.slice(5));
    await this.stoppingSessions.get(resumedId);
    await this.executions.get(resumedId)?.done;
    if (task.type === 'dream' && usesSyncFileQueue(task.input)) {
      const jobId = Number(id.slice(5));
      record!.data.fileSession = true;
      await this.stoppingSessions.get(jobId);
      await this.executions.get(jobId)?.done;
      await Promise.allSettled([...this.fileSessions].filter(([, owner]) => owner === jobId).map(([child]) => this.executions.get(child)?.done));
      await this.reconcileMaintenanceChildren(jobId);
      const checkpoint = task.input.checkpoint;
      delete record!.data.resourceStopReason;
      const progress=(record!.progress??{}) as Progress;
      delete progress.result;
      if(progress.product)progress.product.errorReason=null;
      await this.engine.executeRaw(`UPDATE minion_jobs SET data=(data-'resourceStopReason') || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults' - 'taskBudget'),progress=$3::jsonb WHERE id=$1`,[jobId,record!.data,progress]);
      if (checkpoint) {
        resumeMaintenanceCheckpoint(checkpoint,run.status==='completed' || maintenanceFailure(run.result)!==null,true);
        await this.engine.executeRaw(`UPDATE minion_jobs SET data = data || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults' - 'taskBudget') WHERE id = $1`, [jobId, { ...record!.data, task }]);
      }
      await this.engine.executeRaw(`UPDATE minion_jobs SET status = 'paused', result = NULL WHERE queue = $1 AND (data->>'sessionId')::bigint = $2 AND result->>'status' IN ('failed','error','partial')`, [SYNC_FILE_QUEUE, jobId]);
      await this.clearStopIntent(jobId);
      await this.fileQueue.resume(jobId);
      return this.getRun(id);
    }
    if (task.type !== 'sync-file') {
      await this.reconcileMaintenanceChildren(resumedId);
      if (task.type === 'import') {task.input.resumeCheckpointId = resumedId;if(task.input.knowledgeCheckpoint)resumeMaintenanceCheckpoint(task.input.knowledgeCheckpoint,true,true);}
      if (task.type === 'dream' && task.input.checkpoint) resumeMaintenanceCheckpoint(task.input.checkpoint, true, task.input.phase !== 'capture_entities');
      if (task.type === 'memory' && task.input.knowledgeCheckpoint) resumeMaintenanceCheckpoint(task.input.knowledgeCheckpoint, true);
      const progress = (record!.progress ?? {}) as Progress;
      delete progress.result;
      if (progress.product) progress.product.errorReason = null;
      delete record!.data.resourceStopReason;
      record!.data.authorizedAttempt = record!.attempts_started + 1;
      await this.clearStopIntent(resumedId);
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='waiting',result=NULL,error_text=NULL,lock_token=NULL,lock_until=NULL,delay_until=NULL,finished_at=NULL,
        data=(data-'resourceStopReason') || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults' - 'taskBudget'),progress=$3::jsonb,updated_at=now()
        WHERE id=$1 AND queue=$4 AND status IN ('paused','cancelled','failed','dead','completed')`, [resumedId, record!.data, progress,record!.queue]);
      return this.getRun(id);
    }
    throw new Error('文件任务请通过快速维护继续');
  }

  private async execute(context: MinionJobContext): Promise<unknown> {
    this.checkMemory();
    if(this.failure)throw this.failure;
    if (this.stopped || this.paused) throw new Error('后台任务执行器已停止，任务未开始，请稍后重试');
    context.signal.throwIfAborted();
    context.shutdownSignal.throwIfAborted();
    const record = await this.queue.getJob(context.id);
    if (!record?.lock_token) throw new Error('任务执行租约无效');
    const structuredTask = record.data.task as ProductTask;
    const backgroundOcr=structuredTask.type==='import'&&!!structuredTask.input.ocrOnly;
    if(backgroundOcr){const schedule=await this.vectorizationDecision(context.id);if(schedule.mode==='waiting')return this.deferMaintenance(record,`资料已保存，图片识别${schedule.reason}`,Math.max(1000,schedule.delayMs));}
    if (structuredTask.type === 'embed' && structuredTask.input.searchOptimize) {
      const state = await this.searchOptimizeView();
      if (state.items.length && (state.paused || state.schedule.mode === 'waiting')) {
        const progress = (record.progress ?? {}) as Progress;
        const adapter = new TaskProgressAdapter(String(record.data.kind), progress.product);
        adapter.event({ phase: 'embed', done: state.done, total: state.total, unit: '份资料' });
        await this.settleSearchOptimize(record, adapter, progress, state.schedule);
        return MINION_DEFERRED;
      }
    }
    if (structuredTask.type === 'dream' && structuredTask.input.phase === 'capture_entities' && record.data.trigger !== 'manual') {
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,updated_at=now(),
        error_text='旧版自动实体识别已停用，已保存结果保留；可明确范围后手动继续。'
        WHERE id=$1 AND status='active' AND lock_token=$2`,[context.id,record.lock_token]);
      return MINION_DEFERRED;
    }
    if (structuredTask.type === 'assistant') {
      if (!this.workbenchAssistant) return this.deferMaintenance(record, '等待助手服务启动');
      const abort = new AbortController();
      const agentContext = { ...context, signal: AbortSignal.any([context.signal, context.shutdownSignal, abort.signal]), updateProgress: async (progress: unknown) => { record.progress = progress; await context.updateProgress(progress); } };
      const pending = this.workbenchAssistant(structuredTask.input, agentContext);
      this.executions.set(context.id, { cancel: reason => abort.abort(new Error(reason ?? '任务已停止')), done: pending.then(() => undefined, () => undefined), run: () => toRun(record), ownsLockedTransaction: () => false, adjust: () => {} });
      try { return await pending; } finally { this.executions.delete(context.id); }
    }
    if (structuredTask.type === 'dream' && !structuredTask.input.dryRun) {
      const earlier = await this.engine.executeRaw(`SELECT id FROM minion_jobs WHERE queue=$1 AND id<$2
        AND data->'task'->>'type'='dream' AND data->'task'->'input'->>'dryRun' IS DISTINCT FROM 'true'
        AND status IN ('waiting','active','waiting-children','delayed') LIMIT 1`, [PRODUCT_TASK_QUEUE, context.id]);
      if (earlier.length) return this.deferMaintenance(record);
    }
    if(structuredTask.type==='dream' && usesSyncFileQueue(structuredTask.input)
      && record.data.resourceStopReason && isSyncCapacityError(record.data.resourceStopReason)){
      delete record.data.resourceStopReason;
      await this.engine.executeRaw(`UPDATE minion_jobs SET data=data-'resourceStopReason',error_text=NULL
        WHERE id=$1 AND status='active' AND lock_token=$2`,[context.id,record.lock_token]);
    }
    if(record.data.resourceStopReason && structuredTask.type==='dream' && usesSyncFileQueue(structuredTask.input)){
      const paused=await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,error_text=$2,
        data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),updated_at=now() WHERE id=$1 AND status='active' AND lock_token=$3 RETURNING id`,[context.id,String(record.data.resourceStopReason),record.lock_token]);
      if(paused.length)this.sessionViews.delete(context.id);
      return MINION_DEFERRED;
    }
    const searchOptimize = structuredTask.type === 'embed' && structuredTask.input.searchOptimize === true;
    if (searchOptimize && this.stopIntents.has(context.id) && !this.stoppingSessions.has(context.id) && record.data.searchOptimizePause !== 'manual') {
      const paused = (await loadSearchOptimize(this.engine)).paused;
      if (!paused) await this.clearStopIntent(context.id);
    }
    if (this.stopIntents.has(context.id) || (structuredTask.type==='sync-file' && this.stopIntents.has(Number(record.data.sessionId)))) throw new Error('任务已停止');
    if(structuredTask.type==='dream' && usesSyncFileQueue(structuredTask.input))await this.fileQueue.cleanup(context.id);
    if (structuredTask.type==='sync-file') this.fileProjection.record(record);
    if (structuredTask.type === 'dream' && usesSyncFileQueue(structuredTask.input) && record.attempts_started > 1) {
      const counts = await this.fileQueue.counts(context.id);
      if (counts.total > 0) record.progress = { ...(record.progress as Progress ?? {}), product: { ...toRun(record).product!, syncFiles: counts } };
    }
    if (record.attempts_started > 1 && record.data.authorizedAttempt !== record.attempts_started && !searchOptimize && !backgroundOcr && structuredTask.type !== 'sync-file' && structuredTask.type !== 'memory' && !(structuredTask.type === 'dream' && usesSyncFileQueue(structuredTask.input))) throw new Error('任务执行曾中断，结果不确定，请查看已完成内容后手动继续');
    let progress = (record.progress ?? {}) as Progress;
    const adapter = new TaskProgressAdapter(String(record.data.kind), toRun(record).product);
    let progressDirty=true,lastPersistedAt=0;
    let modelWaitingSince:string|undefined;
    const databaseOperations=new Map<number,NonNullable<TaskProductProgress['activity']>>();
    const updateExecutionActivity=()=>{
      adapter.view.activity=databaseOperations.values().next().value??(modelWaitingSince?{kind:'model',since:modelWaitingSince}:undefined);
      adapter.view.heartbeatAt=new Date().toISOString();progressDirty=true;
    };
    let activity:import('../../../shared/task-progress.ts').SyncFileActivity|undefined=structuredTask.type==='sync-file'?{
      id:context.id,sourceId:structuredTask.input.options.sourceId??'default',path:structuredTask.input.relativePath,
      bytes:structuredTask.input.originalSize??0,stage:'读取资料',noEmbed:structuredTask.input.options.noEmbed,updatedAt:new Date().toISOString(),
    }:undefined;
    const updateActivity=(patch:Partial<import('../../../shared/task-progress.ts').SyncFileActivity>)=>{
      if(!activity)return;
      activity={...activity,...patch,updatedAt:new Date().toISOString()};
      adapter.view.activeFiles=[activity];adapter.view.file=activity.path;adapter.view.stage=activity.stage;
      this.fileProjection.activity(Number(record.data.sessionId),context.id,activity);
    };
    updateActivity({});
    let progressTail = Promise.resolve();
    let persisting = false;
    let progressVersion = 0;
    const persist = () => {
      progressDirty=false;lastPersistedAt=Date.now();
      progress.product = adapter.view;
      progressVersion++;
      if (!persisting) {
        persisting = true;
        const writing = (async () => {
          let saved = 0;
          while (saved < progressVersion) {
            const version = progressVersion;
            await context.updateProgress(structuredClone(progress));
            saved = version;
          }
        })();
        void writing.catch(() => {});
        progressTail = writing.finally(() => { persisting = false; });
        void progressTail.catch(() => {});
      }
      return progressTail;
    };
    const host = new TaskEngineHost(this.engine, context.id, record.lock_token, async file => {
      await appendTaskCheckpoint(context.id, file);
      progress.files = [...(progress.files ?? []), file].slice(-100);
      await persist();
    }, structuredTask.type === 'sync-file', structuredTask.type === 'sync-file' ? structuredTask.input : undefined,this.resources,
    structuredTask.type === 'sync-file' ? Number(record.data.sessionId) : context.id,structuredTask.type==='memory'&&!structuredTask.input.retire?async tx=>{
      const wb=await resolveWritebackConfig(tx,loadConfigFileOnly());
      const input=structuredTask.input;const message=new WorkbenchStore(input.root).get(input.conversationId).messages.find(row=>row.id===input.messageId);
      const sources=await tx.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=false FOR SHARE',[input.sourceId]);
      if(!wb.enabled||!sources.length||message?.memory?.hash!==input.hash||memoryVersion(message)!==input.hash||(wb.visibility==='private'&&message.memory.visibility==='world'))throw new Error('自动记忆已关闭、来源或会话已改变，任务停止写入');
    }:undefined);
    const workerPath = /\/(?:~BUN|\$bunfs)\//.test(decodeURIComponent(import.meta.url))
      ? './product/tasks/task-worker.ts'
      : new URL(import.meta.url.endsWith('.ts') ? './task-worker.ts' : './task-worker.js', import.meta.url);
    if(structuredTask.type!=='sync-file')await this.releaseIdleThreads(this.idleFileThreads);
    if(this.localPressure||this.externalPressure)await this.reclaimIdleThreads();
    const reusableThreads=structuredTask.type==='sync-file'?this.idleFileThreads
      :structuredTask.type==='dream'?this.idleMaintenanceThreads:undefined;
    const cachedThread = reusableThreads?.pop();
    const thread = cachedThread && cachedThread.threadId !== -1 ? cachedThread : new Worker(workerPath, { env: { ...process.env } });
    let threadExited = false;
    let threadClosing = false;
    let threadFailed = false;
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    thread.once('exit', () => { threadExited = true; stop(); });
    let settleResolve!: (value: unknown) => void;
    let settleReject!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
    const send = (message: unknown) => {
      if (threadExited || threadClosing) return;
      try { thread.postMessage(message); }
      catch (error) {
        threadFailed = true;
        threadClosing = true;
        settleReject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    let cancelRequested = false;
    const gitController = new AbortController();
    const gitOperations = new Set<Promise<unknown>>();
    let completed = false;
    let deferred = false;
    let deferredPhase:string|undefined;
    let deferredError:string|undefined;
    let flush: ReturnType<typeof setInterval> | undefined;
    const cancel = (reason?:string) => {
      if (cancelRequested) return;
      cancelRequested = true;
      gitController.abort();
      host.cancel();
      send({ type: 'cancel',reason:reason??'user_stop: 任务已取消' });
      settleReject(new Error(reason??'任务已取消'));
    };
    const finished = (async () => {
      try { return await result; }
      finally {
        threadClosing = true;
        clearInterval(flush);
        thread.removeAllListeners('message');
        try { await host.close(); }
        finally {
          await Promise.allSettled([...gitOperations]);
          try {
            if (!threadExited && !threadFailed && reusableThreads && reusableThreads.length<1 && (completed || deferred) && !cancelRequested && !this.stopped && !this.paused && !this.localPressure && !this.externalPressure) {
              thread.removeAllListeners('error');
              thread.removeAllListeners('exit');
              reusableThreads.push(thread);
              this.scheduleIdleRelease();
            } else if (!threadExited) {
              await thread.terminate();
              await stopped;
            }
            await progressTail;
            const task = record.data.task as ProductTask;
            if (task.type === 'import' && task.input.stagingDir && completed) {
              await removeAdminUploadTempDir(task.input.stagingDir);
            }
          } finally { this.executions.delete(context.id); this.applyResourcePressure(); }
        }
      }
    })();
    this.executions.set(context.id, { background: backgroundOcr || structuredTask.type === 'embed' && structuredTask.input.searchOptimize === true, pause: () => { record.data.searchOptimizePause = 'manual'; }, cancel, done: finished.catch(() => {}), ownsLockedTransaction: () => host.ownsLockedTransaction(), adjust:constrained=>send({type:'resource-pressure',constrained}), run: () => {
      progress.product = adapter.view;
      const run=toRun({ ...record, progress }, cancelRequested);
      if (run.product && structuredTask.type==='dream' && usesSyncFileQueue(structuredTask.input)) run.product.activeFiles=this.fileProjection.active(context.id);
      return run;
    } });
    this.applyResourcePressure();
    const cancelFromSignal=()=>cancel(context.shutdownSignal.aborted?'service_shutdown: 本地服务关闭':context.signal.reason instanceof Error?context.signal.reason.message:undefined);
    context.signal.addEventListener('abort', cancelFromSignal, { once: true });
    context.shutdownSignal.addEventListener('abort', cancelFromSignal, { once: true });
    if (context.signal.aborted || context.shutdownSignal.aborted || this.stopIntents.has(context.id)) cancel();
    thread.once('error', error => { threadFailed = true; settleReject(error instanceof Error ? error : new Error(String(error))); });
    thread.once('exit', code => settleReject(new Error(`任务 Worker 意外退出（${code}）`)));
    thread.on('message', (message: TaskWorkerMessage) => {
      if (message.type === 'rpc') {
        databaseOperations.set(message.id,{kind:message.method.startsWith('task.')?'processing':'database',since:new Date().toISOString(),operation:message.method});
        updateExecutionActivity();
        updateActivity({operation:message.method,operationStartedAt:new Date().toISOString()});
        const dispatch = async () => {
          if(cancelRequested) throw new Error('任务已取消');
          if (message.method === 'task.searchOptimize') return this.acceptSearchOptimize(String(message.args[0] ?? 'default'), Array.isArray(message.args[1]) ? message.args[1].filter((slug): slug is string => typeof slug === 'string') : []);
          if(message.method==='task.documentResources')return this.background.resourceSample();
          if(message.method==='task.documentOcrSchedule')return this.vectorizationDecision(context.id);
          if(message.method==='task.waitingOcr'){
            if(structuredTask.type!=='dream')throw Error('无效的整理识图等待状态');
            record.data.waitingForOcr=message.args[0]===true;
            if(!record.data.waitingForOcr&&adapter.view.background?.reason.includes('后台识图'))delete adapter.view.background;
            await this.engine.executeRaw("UPDATE minion_jobs SET data=jsonb_set(data,'{waitingForOcr}',to_jsonb($3::boolean)) WHERE id=$1 AND status='active' AND lock_token=$2",[context.id,record.lock_token,record.data.waitingForOcr]);
            return null;
          }
          if(message.method==='task.maintenanceVectorizationState'){
            if(structuredTask.type!=='dream')throw new Error('当前任务不能执行维护向量化');
            const state=await loadSearchOptimize(this.engine);
            return {paused:state.paused,schedule:await this.vectorizationDecision(context.id)};
          }
          if (message.method === 'task.searchOptimizeState') return this.searchOptimizeView();
          if (message.method === 'task.searchOptimizeDone') {
            const state = await completeSearchOptimize(this.engine, String(message.args[0] ?? ''), String(message.args[1] ?? ''), typeof message.args[2] === 'string' ? message.args[2] : undefined);
            if (record.data.vectorRetryCount) {
              await this.engine.executeRaw(`UPDATE minion_jobs SET data=data-'vectorRetryCount' WHERE id=$1 AND status='active' AND lock_token=$2`, [context.id, record.lock_token]);
              delete record.data.vectorRetryCount;
            }
            return state;
          }
          if (message.method === 'task.searchOptimizeForgetPage') {
            host.forgetPage(String(message.args[0] ?? ''), String(message.args[1] ?? ''));
            return null;
          }
          if (message.method === 'task.searchOptimizeCaptured') {
            const sourceId = String(message.args[0] ?? 'default');
            const written = Array.isArray(message.args[1]) ? message.args[1].filter((slug): slug is string => typeof slug === 'string') : [];
            const sources = Array.isArray(message.args[2]) ? message.args[2].filter((slug): slug is string => typeof slug === 'string') : [];
            const state = await enqueueCapturedSearchOptimize(this.engine, sourceId, written, sources);
            if (!state.paused && state.items.length) await this.ensureSearchOptimizeJob();
            return { paused: state.paused, pending: state.pending };
          }
          if (message.method === 'task.searchOptimizeRelease') {
            await this.engine.executeRaw(`UPDATE minion_jobs SET idempotency_key = NULL WHERE id = $1 AND idempotency_key = $2 AND status = 'active' AND lock_token = $3`, [context.id, SEARCH_OPTIMIZE_JOB_KEY, record.lock_token]);
            return null;
          }
          if(message.method==='task.captureRequest'){
            const slugs=await claimMaintenanceCapture(this.engine,context.id,record.lock_token!,String(message.args[0]),message.args[1] as string[]|undefined);
            if(slugs&&(structuredTask.type==='dream'||structuredTask.type==='import')){
              const checkpoint=(structuredTask.type==='import'?structuredTask.input.knowledgeCheckpoint:structuredTask.input.checkpoint)??{phases:{},reports:{}};
              checkpoint.captureRequests={...checkpoint.captureRequests,[String(message.args[0])]:slugs};
              if(structuredTask.type==='import')structuredTask.input.knowledgeCheckpoint=checkpoint;else structuredTask.input.checkpoint=checkpoint;
            }
            return slugs;
          }
          if (message.method === 'task.syncFile') {
            const file = message.args[0] as SyncFileInput;
            const result = await this.fileQueue.enqueue(context.id, record.lock_token!, file).catch(async error=>{
              if(isSyncCapacityError(error) && !this.stopIntents.has(context.id) && !this.paused){
                const counts=await this.fileQueue.counts(context.id);
                if(counts.remaining>0)return {slug:'',status:'skipped' as const,chunks:0,deferred:true,capacityReached:true};
              }
              throw error;
            });
            if (!result.deferred && ['imported', 'skipped'].includes(result.status)) await recordSyncedGitFile(this.engine, context.id,
              file.options.sourceId ?? 'default', { path: file.relativePath, hash: file.hash });
            return result;
          }
          if (message.method === 'task.gitCommit') {
            if (structuredTask.type !== 'dream' || structuredTask.input.preset !== 'quick' || structuredTask.input.dryRun) throw new Error('无效的自动 Git 提交任务');
            adapter.view.stage = '保存本地版本'; await persist();
            const sourceId = String(message.args[0]), root = String(message.args[1]);
            const operation = commitQuickMaintenanceSource(this.engine, context.id, sourceId, root, message.args[2] as SyncResult, {
              signal: gitController.signal,
              beforeCommit: async () => {
                const valid = await this.engine.executeRaw(`SELECT j.id FROM minion_jobs j JOIN sources s ON s.id=$3
                  WHERE j.id=$1 AND j.status='active' AND j.lock_token=$2 AND s.local_path=$4 AND NOT s.archived`,
                [context.id, record.lock_token, sourceId, root]);
                if (!valid.length) throw new Error('任务租约或 Source 路径已改变，未提交 Git');
              },
            });
            gitOperations.add(operation);
            try { return await operation; } finally { gitOperations.delete(operation); }
          }
          if(message.method==='task.budget'){
            const reply=await handleTaskBudget(this.engine,context.id,record.lock_token!,message.args[0] as TaskBudgetRequest);
            if(structuredTask.type==='dream'){record.data.taskBudget=reply.state;const {reservations,pendingPricing,...budget}=reply.state;adapter.view.budget=budget;}
            return reply;
          }
          if (message.method === 'task.maintenanceCheckpoint') {
            setMaintenanceCheckpoint(structuredTask, message.args[0] as MaintenanceCheckpoint);
            const rows = await this.engine.executeRaw(`UPDATE minion_jobs SET data = data || ($3::jsonb - 'relations' - 'gitFiles' - 'gitResults' - 'taskBudget'), updated_at = now() WHERE id = $1 AND status = 'active' AND lock_token = $2 RETURNING id`, [context.id, record.lock_token, record.data]);
            if (!rows.length) throw new Error('维护任务已停止或租约失效');
            return null;
          }
          return withDatabaseRequest({ taskId: context.id, token: record.lock_token!, signal: gitController.signal,
            stage: activity?.stage ?? adapter.view.stage, file: activity?.path ?? adapter.view.file ?? undefined,
            onTimeout: error => { withoutDatabaseRequest(() => { void this.requestCancel(`task-${context.id}`, error.message).catch(reason => console.error('[tasks] database timeout:', reason)); }); },
          }, () => host.dispatch(message));
        };
        void withDatabasePriority(['import','sync-file'].includes(structuredTask.type) ? 2 : 3, dispatch).then(value => {
          databaseOperations.delete(message.id);updateExecutionActivity();
          if(activity?.operation===message.method)updateActivity({operation:undefined,operationStartedAt:undefined});
          if (!cancelRequested) send({ type: 'reply', id: message.id, value });
        }, error => {
          databaseOperations.delete(message.id);updateExecutionActivity();
          if(activity?.operation===message.method)updateActivity({operation:undefined,operationStartedAt:undefined});
          if (!cancelRequested) send({ type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) });
        });
      } else if (message.type === 'log') {
        progressDirty=true;
        adapter.write(message.text);
        progress.output = `${progress.output ?? ''}${message.text}`.slice(-100_000);
      } else if (message.type === 'progress') {
        progressDirty=true;
        if (message.background) adapter.view.background = message.background;
        if (message.phases) adapter.plan(message.phases);
        if (message.scope) adapter.scope(message.scope);
        if (message.event) {
          adapter.event(message.event); host.setRelationPhase(message.event.phase);
          const stage=message.event.stage??'';
          if(stage.includes('模型第')){modelWaitingSince=stage.includes('等待')?modelWaitingSince??new Date().toISOString():undefined;updateExecutionActivity();}
        }
        if (message.syncScan) adapter.scan(message.syncScan);
        if (message.page && adapter.view.material) adapter.view.material.page = message.page;
        if(message.event)updateActivity({stage:({'import.process':'解析与切分','import.vector':'生成向量','import.write':'写入知识库'} as Record<string,string>)[message.event.phase]??activity?.stage});
        if(message.largeDocument){
          const large=message.largeDocument;
          updateActivity({stage:({parsed:'解析完成',chunked:'切分完成',writing:'写入正文分块',embedding:'生成并写入向量',partial:'向量部分完成',completed:'资料处理完成',failed:'资料处理失败'})[large.phase],
            chunksTotal:large.chunksTotal,bodyWritten:large.bodyWritten,bodyCommitted:large.bodyCommitted,bodyBatchesCompleted:large.bodyBatchesCompleted,bodyBatchesTotal:large.bodyBatchesTotal,generated:large.generated,
            embedded:large.embedded,reused:large.reused,pending:large.pending,batchesCompleted:large.batchesCompleted});
        }
      } else if (message.type === 'result') {
        completed = true;
        progress.result = message.result;
        void persist().then(() => settleResolve(message.result), settleReject);
      } else if (message.type === 'error') {
        progress.result = message.result;
        void persist().then(() => settleReject(new Error(message.error)), settleReject);
      } else if (message.type === 'deferred') {
        deferredPhase=message.phase;
        deferredError=message.error;
        deferred = true;
        void persist().then(() => settleResolve(MINION_DEFERRED), settleReject);
      }
    });
    flush = setInterval(() => {if(progressDirty&&Date.now()-lastPersistedAt>=5000)void persist().catch(settleReject);}, 1000);
    send({ type: 'start', kind: this.engine.kind, task: record.data.task, ownerJobId: context.id, ownerToken:record.lock_token, constrained:this.localPressure||this.externalPressure });
    let importVectorsQueued = false;
    const queueImportVectors = async () => {
      if (importVectorsQueued) return;
      importVectorsQueued = true;
      await this.queueDeferredImportVectors(structuredTask, progress.result, cancelRequested);
    };
    try {
      const outcome = await finished;
      await queueImportVectors();
      if (structuredTask.type === 'import') await persist();
      if (structuredTask.type === 'embed' && structuredTask.input.searchOptimize === true && outcome !== MINION_DEFERRED && !cancelRequested) {
        const embedded = outcome as { status?: string; error?: string };
        if (!embedded?.error && (embedded?.status === 'ok' || embedded?.status === 'clean')) {
          await this.ensureSearchOptimizeJob().catch(error => console.error('[tasks] search optimize:', error));
        }
      }
      if (outcome === MINION_DEFERRED && deferredPhase === 'search_optimize') {
        if (!this.stopIntents.has(context.id)) await this.settleSearchOptimize(record, adapter, progress, undefined, deferredError);
        return MINION_DEFERRED;
      }
      if (structuredTask.type === 'dream' && outcome !== MINION_DEFERRED && (outcome as { reason?: string })?.reason === 'cycle_already_running') return this.deferMaintenance(record);
      if (outcome === MINION_DEFERRED && !this.stopIntents.has(context.id)) {
        if(deferredPhase==='maintenance_ocr')return this.deferMaintenance(record,'资料已保存，等待后台识图后继续整理和向量化',1000);
        if(deferredPhase==='document_ocr')return this.deferMaintenance(record,'资料已保存，后台识图等待电脑空闲',1000);
        if(deferredPhase==='maintenance_embed'){
          const state=await loadSearchOptimize(this.engine),schedule=await this.vectorizationDecision(context.id);
          for(const step of adapter.view.steps)if(step.phases.includes('embed'))step.status='pending';
          adapter.view.background={mode:'waiting',reason:state.paused?'知识向量化已暂停':schedule.reason};
          await persist();record.progress=progress;
          return this.deferMaintenance(record,state.paused?'知识向量化已暂停，维护成果已保存':`${schedule.reason}，维护成果已保存`,Math.max(1000,schedule.delayMs));
        }
        if(deferredPhase==='capture_entities'){
          await persist();record.progress=progress;
          return this.deferMaintenance(record,'本批已保存，等待继续识别实体');
        }
        if(adapter.view.syncScan)adapter.view.syncScan.active=false;
        const counts = await this.fileQueue.counts(context.id);
        adapter.view.syncFiles = counts;
        adapter.view.processed = counts.completed + counts.failed;
        adapter.view.total = counts.total;
        adapter.view.stage = '同步资料';
        adapter.view.phasePercent = counts.total ? Math.floor((counts.completed + counts.failed) / counts.total * 1000)/10 : null;
        await persist();
        await this.fileQueue.release(context.id, record.lock_token);
        this.sessionViews.set(context.id, toRun({ ...record, progress, status: counts.remaining > 0 ? 'waiting-children' : 'waiting' }));
        this.scheduleSessionRefresh(context.id);
      } else {
        if (structuredTask.type === 'dream' && usesSyncFileQueue(structuredTask.input) && !this.stopIntents.has(context.id)) {
          const counts=await this.fileQueue.counts(context.id);
          if (counts.total>0) {
            adapter.view.syncFiles=counts;adapter.view.processed=counts.completed+counts.failed;adapter.view.total=counts.total;
            adapter.view.activeFiles=[];await persist();
          }
        }
        if (structuredTask.type === 'dream' && usesSyncFileQueue(structuredTask.input)) await this.fileQueue.cleanup(context.id).catch(error => console.error('[tasks] snapshot cleanup:', error));
      }
      return outcome;
    }
    catch(error){
      if (searchOptimize && !this.stoppingSessions.has(context.id) && record.data.searchOptimizePause !== 'manual') {
        const message = error instanceof Error ? error.message : String(error);
        if (vectorizationInterrupted(message) && !(await loadSearchOptimize(this.engine)).paused) {
          await this.clearStopIntent(context.id);
          await this.settleSearchOptimize(record, adapter, progress);
          return MINION_DEFERRED;
        }
      }
      if (!this.recoveringOwner && !isExpectedDatabaseInterruptReason(error)) {
        await queueImportVectors().catch(reason => console.error('[tasks] deferred embed:', reason));
        if (structuredTask.type === 'import') await persist().catch(reason => console.error('[tasks] deferred embed:', reason));
      }
      if(structuredTask.type==='dream'&&usesSyncFileQueue(structuredTask.input) && String(error).includes('资源保护：')){
        const message=error instanceof Error?error.message:String(error);
        if(isSyncCapacityError(error) && !this.stopIntents.has(context.id) && !this.paused){
          const counts=await this.fileQueue.counts(context.id);
          if(counts.remaining>0){
            delete record.data.resourceStopReason;
            const owned=await this.engine.executeRaw(`UPDATE minion_jobs SET data=(data-'resourceStopReason') || ($2::jsonb - 'relations' - 'gitFiles' - 'gitResults' - 'taskBudget'),error_text=NULL WHERE id=$1 AND status='active' AND lock_token=$3 RETURNING id`,[context.id,record.data,record.lock_token]);
            if(!owned.length)return MINION_DEFERRED;
            await this.fileQueue.release(context.id,record.lock_token);
            this.scheduleSessionRefresh(context.id);
            return MINION_DEFERRED;
          }
        }
        await this.fileQueue.pause(context.id);
      }
      throw error;
    }
    finally {
      clearInterval(flush);
      context.signal.removeEventListener('abort', cancelFromSignal);
      context.shutdownSignal.removeEventListener('abort', cancelFromSignal);
    }
  }

  private async settleSearchOptimize(record: MinionJob, adapter: TaskProgressAdapter, progress: Progress, schedule?: VectorizationSchedule, retryError?: string): Promise<void> {
    const state = await loadSearchOptimize(this.engine);
    const retryCount = Number(record.data.vectorRetryCount ?? 0);
    const retryDelay = retryError ? vectorizationRetryDelay(retryError, retryCount) : null;
    if (retryError && retryDelay === null && !state.paused) throw new Error(retryError);
    schedule ??= await this.vectorizationDecision();
    if (retryError && retryDelay !== null) schedule = { mode: 'waiting', reason: '向量服务暂时不可用，稍后自动重试', batchSize: 0, delayMs: retryDelay };
    adapter.view.background = { mode: schedule.mode, reason: schedule.reason };
    adapter.view.stage = state.paused ? '已暂停，已完成的部分保留' : schedule.reason;
    adapter.view.errorReason = state.paused ? SEARCH_OPTIMIZE_PAUSED : null;
    adapter.view.detail = retryError ?? null;
    progress.product = adapter.view;
    if (state.paused) {
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused', lock_token=NULL, lock_until=NULL,
        error_text=$3, finished_at=COALESCE(finished_at, now()), updated_at=now(), progress=$4::jsonb,
        data=jsonb_set(data, '{searchOptimizePause}', '"manual"'::jsonb)
        WHERE id=$1 AND status='active' AND lock_token=$2`, [record.id, record.lock_token, SEARCH_OPTIMIZE_PAUSED, progress]);
    } else {
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='delayed', delay_until=now()+($4::double precision * interval '1 millisecond'), lock_token=NULL, lock_until=NULL,
        error_text=NULL, finished_at=NULL, updated_at=now(), progress=$3::jsonb,
        data=(data-'searchOptimizePause') || $5::jsonb
        WHERE id=$1 AND status='active' AND lock_token=$2`, [record.id, record.lock_token, progress, Math.max(250, schedule.delayMs), retryError ? { vectorRetryCount: retryCount + 1 } : {}]);
    }
    this.sessionViews.delete(record.id);
  }

  private async deferMaintenance(record: MinionJob, stage = '等待前面的整理任务完成',delayMs=1000): Promise<typeof MINION_DEFERRED> {
    const progress = (record.progress ?? {}) as Progress;
    delete progress.result;
    const view = progress.product ?? new TaskProgressAdapter(String(record.data.kind)).view;
    view.stage = stage; view.percent = null; view.errorReason = null;
    if(record.data.waitingForOcr||record.data.kind==='document_ocr')view.background={mode:'waiting',reason:stage};
    progress.product = view;
    await this.engine.executeRaw(`UPDATE minion_jobs SET status='delayed',delay_until=now()+($4::double precision * interval '1 millisecond'),
      lock_token=NULL,lock_until=NULL,error_text=NULL,result=NULL,progress=$3::jsonb,
      attempts_started=GREATEST(attempts_started-1,0),updated_at=now()
      WHERE id=$1 AND status='active' AND lock_token=$2`, [record.id, record.lock_token, progress,delayMs]);
    this.sessionViews.delete(record.id);
    return MINION_DEFERRED;
  }

  private async recoverCapacitySessions(){
    const seen=new Set<string>();
    const jobs=await this.queue.getJobs({queue:PRODUCT_TASK_QUEUE,name:TASK_NAME,limit:100});
    for(const job of jobs.sort((left,right)=>right.id-left.id)){
      const task=job.data.task as ProductTask;
      if(task?.type!=='dream' || !usesSyncFileQueue(task.input))continue;
      const source=task.input.allSources?'*':task.input.sourceId??'default';
      if(seen.has(source))continue;
      seen.add(source);
      if(this.stopIntents.has(job.id) || !['paused','failed','dead'].includes(job.status)
        || !isSyncCapacityError(job.data.resourceStopReason??job.error_text))continue;
      const uncertain=await this.engine.executeRaw(`SELECT id FROM minion_jobs WHERE (queue=$1 AND parent_job_id=$2
        AND (status IN ('active','dead','failed') OR result->>'status' IN ('failed','error','partial')
          OR (attempts_started>0 AND COALESCE((data->'task'->'input'->>'modelMayRun')::boolean,
            data->'task'->'input'->'options'->>'documentOcr'='true') AND result->>'pageHash' IS NULL)))
        OR (private_queue_owner_job_id=$2 AND attempts_started>0 AND status<>'completed') LIMIT 1`,[SYNC_FILE_QUEUE,job.id]);
      if(!uncertain.length)await this.retry(`task-${job.id}`).catch(error=>console.error('[tasks] capacity recovery:',error));
    }
  }

  private checkMemory():number{
    if(this.stopped)return 0;
    const pressure=this.resources.memoryPressure();
    this.localPressure=pressure.level!=='normal';
    this.applyResourcePressure();
    if(pressure.level==='critical')this.stopForResourcePressure(`资源保护：${pressure.reason}，已停止后台任务，普通服务继续运行。`);
    return this.resources.memoryBytes();
  }

  async adjustResourcePressure(constrained:boolean):Promise<void>{
    this.externalPressure=constrained;
    this.applyResourcePressure();
    if(constrained)await this.reclaimIdleThreads();
  }

  private applyResourcePressure():void{
    const constrained=this.localPressure||this.externalPressure;
    const backgroundActive = [...this.executions.values()].some(execution => execution.background);
    this.worker.setConcurrency(constrained && !backgroundActive ? 1 : 2);
    const ocrActive=[...this.executions.values()].some(execution=>execution.run().kind==='document_ocr');
    this.fileWorker.setConcurrency(ocrActive?2:constrained||this.engine.kind==='pglite'?1:documentResourcePlan(this.background.resourceSample()).concurrency);
    for(const execution of this.executions.values())execution.adjust(constrained);
    if(constrained)void this.reclaimIdleThreads().catch(error=>console.error('[tasks] resource reclaim:',error));
  }

  private async releaseIdleThreads(pool:Worker[]):Promise<void>{
    await Promise.all(pool.splice(0).map(thread=>thread.terminate()));
  }

  private reclaimIdleThreads():Promise<void>{
    if(!this.reclaiming){
      this.reclaiming=Promise.all([this.releaseIdleThreads(this.idleFileThreads),this.releaseIdleThreads(this.idleMaintenanceThreads)])
        .then(()=>{if(typeof Bun!=='undefined')Bun.gc(false);}).finally(()=>{this.reclaiming=null;});
    }
    return this.reclaiming;
  }

  private scheduleIdleRelease():void{
    if(this.idleTimer)clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>{this.idleTimer=null;void this.reclaimIdleThreads().catch(error=>console.error('[tasks] idle release:',error));},30000);
    this.idleTimer.unref();
  }

  stopForResourcePressure(message:string):void{
    if(!this.resourceDrain&&!this.stopped){
      this.failure=new Error(message);this.paused=true;this.worker.stop();this.fileWorker.stop();
      for(const execution of this.executions.values())execution.cancel(message);
      this.resourceDrain=(async()=>{
        await Promise.all([...this.idleFileThreads.splice(0),...this.idleMaintenanceThreads.splice(0)].map(thread=>thread.terminate()));
        try { await withDeadline(Promise.allSettled([...this.executions.values()].map(execution=>execution.done)),3000,'资源停止等待数据库响应'); }
        catch { await this.recoverStoppedDatabase(); }
        await this.loop;await this.fileLoop;
        await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,
          data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),error_text=$3,updated_at=now()
          WHERE queue IN ($1,$2) AND status NOT IN ('completed','failed','dead','cancelled')`,[PRODUCT_TASK_QUEUE,SYNC_FILE_QUEUE,message]);
      })().catch(error=>console.error('[tasks] resource stop:',error));
    }
  }

  async close(): Promise<void> {
    await this.workbenchMemory?.close();
    this.closeWorkbenchAssistant?.();
    this.stopped = true;
    await this.recoveringOwner?.catch(error => console.error('[tasks] database recovery:', error instanceof Error ? error.message : error));
    if(this.resourceTimer)clearInterval(this.resourceTimer);
    if(this.idleTimer)clearTimeout(this.idleTimer);
    await this.reclaiming;
    await this.resourceDrain;
    for (const refresh of this.sessionRefresh.values()) clearTimeout(refresh.timer);
    this.sessionRefresh.clear();
    this.worker.stop();
    this.fileWorker.stop();
    const resume = this.engine.executeRaw(`UPDATE minion_jobs SET data = jsonb_set(data, '{resumeOnRestart}', 'true'::jsonb)
      WHERE queue = $1 AND (data->'task'->'input'->>'preset' = 'quick' OR data->>'fileSession'='true' OR data->'task'->>'type'='memory') AND status IN ('active','waiting-children')`, [PRODUCT_TASK_QUEUE]);
    const interrupted = [...this.executions.keys()];
    for (const execution of this.executions.values()) execution.cancel('service_shutdown: 本地服务关闭');
    const drained = Promise.all([resume, Promise.allSettled([...this.executions.values()].map(execution => execution.done))]);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([drained.then(() => true), new Promise<boolean>(resolve => { closeTimer=setTimeout(()=>resolve(false),3000); })]).finally(()=>clearTimeout(closeTimer));
    if (!closed) {
      if (!(this.engine instanceof WorkerPgliteEngine)) throw new Error('退出尚未完成：数据库操作未响应取消');
      await this.recoverStoppedDatabase();
      await drained.catch(()=>{});
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,
        data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),error_text='退出时数据库操作未响应，已保留提交内容，请手动继续。',updated_at=now()
        WHERE queue IN ($1,$2) AND status IN ('active','waiting-children')`,[PRODUCT_TASK_QUEUE,SYNC_FILE_QUEUE]);
    }
    await this.fileProjection.flush();
    await this.loop;
    await this.fileLoop;
    await Promise.all([...this.idleFileThreads.splice(0),...this.idleMaintenanceThreads.splice(0)].map(thread => thread.terminate()));
    await this.refreshingRuns;
    await this.ocrOverviewRefreshing;
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
    await Promise.all([...this.idleFileThreads.splice(0),...this.idleMaintenanceThreads.splice(0)].map(thread => thread.terminate()));
    await Promise.allSettled([...this.executions.values()].map(execution => execution.done));
    this.loop = null;
  }

  async resume(): Promise<void> {
    if(this.resourceDrain)throw this.failure??new Error('资源保护已停止执行器，请重启服务');
    this.paused = false;
    this.failure = null;
    if (!this.stopped) await this.start();
  }

  private async refreshSession(id: number, file?: string) {
    if(this.stopIntents.has(id)||this.recoveringOwner)return;
    const job = await this.queue.getJob(id);
    if (!job || ['completed','cancelled','dead','failed','paused'].includes(job.status)) { this.sessionViews.delete(id); return; }
    const run = toRun(job);
    const counts = await this.fileQueue.counts(id);
    await this.hydrateFiles([id],true);
    if(this.stopIntents.has(id))return;
    if (run.product && counts.total > 0) {
      run.product.syncFiles = counts;
      run.product.processed = counts.completed + counts.failed;
      run.product.total = counts.total;
      run.product.activeFiles=this.fileProjection.active(id);
      if (job.status === 'waiting-children') {
        run.product.stage = '同步资料';
        run.product.phasePercent = Math.floor((counts.completed + counts.failed) / counts.total * 1000)/10;
        if (file) run.product.file = file;
      }
      job.progress = { ...(job.progress as Record<string, unknown> ?? {}), product: run.product };
      await this.engine.executeRaw(`UPDATE minion_jobs SET progress = $2::jsonb WHERE id = $1 AND status IN ('waiting-children','waiting')`, [id, job.progress]);
    }
    this.sessionViews.set(id, run);
    this.cached = [run, ...this.cached.filter(row => row.id !== run.id)].slice(0, 120);
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

  private async persistStopIntent(id: number, reason?: string): Promise<void> {
    const path = taskArtifactPath(id, 'stop.json');
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ id, requestedAt: new Date().toISOString(), reason })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }

  private async clearStopIntent(id: number): Promise<void> {
    await unlink(taskArtifactPath(id, 'stop.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    this.sessionViews.delete(id);
    this.stopIntents.delete(id);
    this.stopAcknowledgements.delete(id);
  }

  private async stopSession(id: number, original: ConsoleRun, acknowledgement: Promise<void>, reason?: string) {
    await acknowledgement;
    const files = [...this.fileSessions].filter(([, owner]) => owner === id).map(([child]) => this.executions.get(child)).filter(Boolean);
    let failure: unknown;
    let saved:MinionJob|null=null;
    const stopping = withDatabasePriority(0, async () => {
      await this.cancelDependentOcr(id, reason);
      saved=await this.queue.cancelJob(id);
      await this.applyStop(id, reason);
      await Promise.allSettled([this.executions.get(id)?.done, ...files.map(execution => execution!.done)]);
      await this.reconcileMaintenanceChildren(id);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      stopping.then(() => true, error => { failure = error; return true; }),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
    ]).finally(() => clearTimeout(timer));
    if (!settled || (failure && this.recoveringOwner)) {
      const view = this.sessionViews.get(id);
      if (view?.product) view.product.stage = '停止当前操作并恢复数据库';
      if (view?.product) view.product.activity = { kind:'recovery',since:new Date().toISOString() };
      await this.recoverStoppedDatabase();
      await stopping.catch(() => {});
      await this.cancelDependentOcr(id, reason);
      saved=await this.queue.cancelJob(id);
      await this.applyStop(id, reason);
      await this.reconcileMaintenanceChildren(id);
      if (!this.stopped && !this.paused && this.loop === null) await this.start();
    } else if (failure) throw failure;
    if (taskUsesFileQueue(original.kind)) {
      await this.hydrateFiles([id]);
      await this.fileProjection.flush();
      void this.fileQueue.cleanupStoppedSnapshots(id).catch(error => console.error('[tasks] stopped snapshot cleanup:', error));
    }
    const status = reason ? 'failed' as const : 'cancelled' as const;
    const persisted=saved as MinionJob|null;
    const finished = persisted?.status==='completed'?toRun(persisted):{ ...original, status, error: reason ?? null, completedAt: new Date().toISOString(),
      product: original.product ? finishTaskProgress(original.product, status, original.result, reason ?? null) : undefined };
    this.sessionViews.set(id, finished);
    this.cached = [finished, ...this.cached.filter(run => run.id !== original.id)].slice(0, 120);
  }

  private async recoverStoppedDatabase(): Promise<void> {
    if (this.recoveringOwner) return this.recoveringOwner;
    if (!(this.engine instanceof WorkerPgliteEngine)) throw new Error('停止尚未完成：数据库操作未响应取消，请检查数据库连接');
    const wasPaused = this.paused;
    const wasRunning = this.loop !== null;
    this.paused = true;
    this.worker.stop(); this.fileWorker.stop();
    for (const execution of this.executions.values()) execution.cancel();
    this.recoveringOwner = (async () => {
      await (this.engine as unknown as WorkerPgliteEngine).interruptAndRecover();
      await withDeadline(Promise.allSettled([...this.executions.values()].map(execution => execution.done)), 10000, '数据库已恢复，旧任务未在 10 秒内结束');
      await this.engine.executeRaw(`UPDATE minion_jobs SET status='paused',lock_token=NULL,lock_until=NULL,
        data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),error_text='数据库执行曾中断，请查看已完成资料后手动继续。',updated_at=now()
        WHERE queue IN ($1,$2) AND status IN ('active','waiting-children')`, [PRODUCT_TASK_QUEUE, SYNC_FILE_QUEUE]);
      await withDeadline(Promise.all([this.loop, this.fileLoop]), 10000, '数据库已恢复，旧队列未在 10 秒内结束');
      this.loop = null; this.fileLoop = null; this.failure = null;
    })();
    try { await this.recoveringOwner; }
    catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); throw error; }
    finally { this.recoveringOwner = null; }
    this.paused = wasPaused;
    if (wasRunning && !this.stopped && !this.paused && this.stopIntents.size === 0) await this.start();
  }

  private async reconcileMaintenanceChildren(id: number) {
    const queues = await this.engine.executeRaw<{ queue: string }>(`SELECT DISTINCT child.queue FROM minion_jobs child
      JOIN minion_jobs owner ON owner.id=child.private_queue_owner_job_id
      WHERE owner.id=$1 AND owner.status IN ('completed','cancelled','dead','failed','paused')
      AND child.queue LIKE 'dream-inline-%' AND child.status IN ('waiting','active','delayed','waiting-children','paused')`, [id]);
    for (const row of queues) await this.queue.reconcilePrivateQueue(row.queue, 'maintenance stopped before continuation');
  }

  private async cancelDependentOcr(jobId: number, reason?: string) {
    const dependentOcr = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs WHERE name=$1 AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$2 AND status IN ('waiting','active','delayed')`, [DOCUMENT_OCR_TASK, String(jobId)]);
    for (const child of dependentOcr) {
      this.executions.get(child.id)?.cancel(reason);
      await this.engine.executeRaw("UPDATE minion_jobs SET data=jsonb_set(data,'{ocrOwnerCancelled}','true'::jsonb) WHERE id=$1", [child.id]);
      await this.queue.cancelJob(child.id);
    }
  }

  private async applyStop(id:number, reason?:string){
    await this.engine.executeRaw(`UPDATE minion_jobs SET status=$3,lock_token=NULL,lock_until=NULL,error_text=$4,
      data=jsonb_set(data,'{resumeOnRestart}','false'::jsonb),finished_at=now(),updated_at=now()
      WHERE id=$1 AND queue=$2 AND status<>'completed'`,[id,PRODUCT_TASK_QUEUE,reason?'failed':'cancelled',reason??null]);
    await this.fileQueue.pause(id);
  }

  private async loadStopIntents(){
    const example=taskArtifactPath(1,'stop.json');
    const prefix=basename(example).split('-job-')[0]+'-job-';
    const entries=await readdir(dirname(example)).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of entries){
      if(!name.startsWith(prefix)||!name.endsWith('.stop.json'))continue;
      const id=Number(name.slice(prefix.length,-'.stop.json'.length));
      if(Number.isSafeInteger(id)&&id>0){
        const command=JSON.parse(await readFile(taskArtifactPath(id,'stop.json'),'utf8'));
        if(command.id!==id)throw new Error('停止命令与任务身份不一致');
        this.stopIntents.add(id);await this.applyStop(id,typeof command.reason==='string'?command.reason:undefined);
      }
    }
  }

  private async hydrateFiles(ids:number[],dirtyOnly=false){
    for(const id of ids){
      const selected=dirtyOnly?[...(this.dirtyFiles.get(id)??[])]:null;
      if(selected?.length===0)continue;
      let after=0;
      for(;;){
        const rows=await this.engine.executeRaw<import('../../../shared/task-progress.ts').SyncFileDetails['rows'][number]>(
          `SELECT id, data->'task'->'input'->'options'->>'sourceId' AS "sourceId",data->'task'->'input'->>'relativePath' AS path,
           CASE WHEN result->>'status' IN ('failed','partial','error') OR status IN ('dead','failed') THEN 'failed'
             WHEN status='completed' THEN 'completed' WHEN status='active' THEN 'running' ELSE 'pending' END AS status,
           COALESCE(result->>'error',error_text) AS error,progress->'product'->'activeFiles'->0 AS activity
           FROM minion_jobs WHERE queue=$1 AND (data->>'sessionId')::bigint=$2 AND id>$3
             AND data->>'superseded' IS DISTINCT FROM 'true' AND ($4::bigint[] IS NULL OR id=ANY($4::bigint[])) ORDER BY id LIMIT 200`,[SYNC_FILE_QUEUE,id,after,selected]);
          this.fileProjection.seed(id,rows);
          await this.fileProjection.flush();
        for(const row of rows)if(row.status!=='running')this.dirtyFiles.get(id)?.delete(row.id);
        if(rows.length<200)break;
        after=rows.at(-1)!.id;
      }
    }
  }

  private async recoverSessions() {
    const rows = await this.engine.executeRaw<{ id: number }>(`SELECT id FROM minion_jobs AS parent WHERE queue = $1
      AND (data->'task'->'input'->>'preset' = 'quick' OR data->>'fileSession'='true') AND (status IN ('active','waiting-children')
        OR (status = 'paused' AND data->>'resumeOnRestart' = 'true'))
      AND ($2::boolean OR ((parent.lock_until IS NULL OR parent.lock_until <= now()) AND NOT EXISTS (
        SELECT 1 FROM minion_jobs child WHERE (child.data->>'sessionId')::bigint = parent.id
        AND child.status = 'active' AND child.lock_until > now())))`, [PRODUCT_TASK_QUEUE, this.engine.kind === 'pglite']);
    for (const { id } of rows) {
      await this.engine.executeRaw(`UPDATE minion_jobs SET stalled_counter=stalled_counter+1
        WHERE queue=$1 AND parent_job_id=$2 AND status='active' AND lock_until<=now()`,[SYNC_FILE_QUEUE,id]);
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
        if (synced && (parent?.status === 'active' || (task.type === 'dream' && task.input.preset !== 'quick'))) {
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
