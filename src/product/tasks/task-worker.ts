import type { BrainEngine } from '../../core/engine.ts';
import type { ProductTask, TaskWorkerMessage, MaintenanceCheckpoint } from './types.ts';
import {DocumentOcrDeferred,validateDeferredDocument,cleanupDeferredDocument} from '../../core/pmbrain-adapters/deferred-document-ocr';
import { loadConfig } from '../../core/config.ts';
import { reloadLiveGateway } from '../../core/ai/reload-live-gateway.ts';
import { DEFAULT_CLI_OPTIONS, setCliOptions } from '../../core/cli-options.ts';
import { runStructuredImport, importSyncFile } from '../../commands/import.ts';
import { runCycle, type CyclePhase } from '../../core/cycle.ts';
import { resolveDreamPresetPhases, resolveDreamRelationOptions, resolveBrainDir } from '../../commands/dream.ts';
import { runQuickMaintenance, combineQuickMaintenanceReports, resolveQuickMaintenancePhases } from '../../core/quick-maintenance.ts';
import { ALL_PHASES } from '../../core/cycle.ts';
import { chooseCaptureModel, configuredCnyPrices } from '../../core/cycle/capture-entities.ts';
import { readEntityCaptureCostCap } from '../../core/cycle/entity-capture-budget.ts';
import {runWithDreamBudget,checkDreamBudget} from './dream-budget';
import {openTaskBudget,type TaskBudgetReply} from './task-budget';
import {withTaskBudgetTracker} from '../../core/ai/gateway';
import {DEFAULT_USD_TO_CNY} from '../../../shared/model-billing';
import {isLocalConfiguredModel} from '../../../shared/model-services';
import { splitProviderModelId } from '../../core/model-id.ts';
import { maintenanceFailure } from './maintenance-orchestration.ts';
import { fetchSource, loadAllSources, parseSourceConfig } from '../../core/sources-load.ts';
import { resolveSourceId } from '../../core/source-resolver.ts';
import { runEmbedCore } from '../../commands/embed.ts';
import { assignSearchOptimizeAcceptance, vectorizationRetryDelay, type SearchOptimizeAcceptance } from './search-optimize.ts';
import { parentPort } from 'node:worker_threads';
import { format } from 'node:util';
import { stat } from 'node:fs/promises';
import { setImmediate as yieldExecution, setTimeout as waitForBatch } from 'node:timers/promises';
import type { VectorizationSchedule } from '../../../shared/background-vectorization';
import {DocumentRuntime,type DocumentResourceSample} from '../../core/document/resource-policy.ts';
import { streamFileHash, assertImportFileSize, isOversizedImportError, resourceProtectionAbortsTask } from './resource-guard.ts';
import { relative, isAbsolute, join } from 'node:path';
import { SyncFilesDeferred, type SyncFileRuntime } from '../../core/sync-file-runtime.ts';
import {EntityCaptureWindowDeferred} from '../../core/pmbrain-adapters/entity-capture-window.ts';
import {mergeCaptureWindow} from './capture-window.ts';
import {runMaintenanceVectorization,mergeEmbeddingWindow,MaintenanceVectorizationDeferred,type MaintenanceVectorizationState} from './maintenance-vectorization.ts';
import {readDocumentChunkManifest} from '../../core/document/chunk-manifest.ts';
import { classifyErrorCode, isInfrastructureFailureCode } from '../../core/sync-failure-ledger.ts';
import { performSync } from '../../commands/sync.ts';
import { readTaskCheckpoint, taskModelFingerprint, syncFileContentFingerprint, retireAutomaticCapture } from './checkpoint.ts';
import { usesSyncFileQueue } from '../../../shared/task-progress.ts';
import { isGinRepairAbortText } from '../../core/pglite-gin-repair.ts';
import type { SyncStrategy } from '../../core/sync.ts';
import { isOfficeFilePath } from '../../core/sync.ts';
import { isImageFilePath } from '../../core/import-file.ts';

let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let abort = new AbortController();
let ownerJobId: number | null = null;
let ownerToken:string|undefined;
const send = (message: TaskWorkerMessage) => parentPort!.postMessage(message);
let importFile: string | undefined;
let backgroundDocumentOcr=false;
let constrained=false;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  const target = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (importFile && /\/embeddings(?:\?|$)|:embedContent|:batchEmbedContents|\/api\/embed(?:\?|$)/.test(target)) send({ type: 'progress', event: { phase: 'import.vector', file: importFile } });
  const requestSignal=args[1]?.signal??(args[0] instanceof Request?args[0].signal:undefined);
  return originalFetch(args[0],{...args[1],...(backgroundDocumentOcr?{keepalive:false}:{}),signal:AbortSignal.any([abort.signal,...(requestSignal?[requestSignal]:[])])});
}) as typeof fetch;

function rpcValue(value: unknown): unknown {
  if (value instanceof AbortSignal || typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(rpcValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rpcValue(child)]));
  }
  return value;
}

function rpc(method: string, args: unknown[], scope?: number): Promise<unknown> {
  abort.signal.throwIfAborted();
  const id = ++sequence;
  if (importFile && ['putPage', 'upsertChunks', 'updateChunkEmbedding', 'setPageAliases'].includes(method)) {
    send({ type: 'progress', event: { phase: 'import.write', file: importFile } });
    if (method === 'putPage') {
      const page = args[1] as { title: string; type: string };
      send({ type: 'progress', page: { slug: String(args[0]), title: page.title, type: page.type } });
    }
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'rpc', id, method, args: args.map(rpcValue), scope });
  });
}

function proxyEngine(kind: BrainEngine['kind'], scope?: number): BrainEngine {
  return new Proxy({ kind }, {
    get(target, property) {
      if (property === 'kind') return target.kind;
      if (['then', '_db', '_sql'].includes(String(property))) return undefined;
      if (property === 'db') return {
        query: async (sql: string, args: unknown[] = []) => ({ rows: await rpc('executeRaw', [sql, args], scope) }),
      };
      if (property === 'sql') return (parts: TemplateStringsArray, ...args: unknown[]) => {
        const sql = parts.reduce((text, part, index) => `${text}${index ? `$${index}` : ''}${part}`, '');
        return rpc('executeRaw', [sql, args], scope);
      };
      if (property === 'transaction' || property === 'withReservedConnection') {
        return async (fn: (engine: BrainEngine) => Promise<unknown>) => {
          const child = await rpc(`${String(property)}.open`, [], scope) as number;
          try {
            const result = await fn(proxyEngine(kind, child));
            await rpc('scope.close', [true], child);
            return result;
          } catch (error) {
            if (!abort.signal.aborted) await rpc('scope.close', [false], child).catch(() => {});
            throw error;
          }
        };
      }
      return (...args: unknown[]) => rpc(String(property), args, scope);
    },
  }) as BrainEngine;
}

const writeLog = (chunk: unknown) => {
  const text=String(chunk);
  for(const line of text.split('\n')){
    if(line.startsWith('[pmbrain large-document] ')){
      try{send({type:'progress',largeDocument:JSON.parse(line.slice('[pmbrain large-document] '.length))});}catch{}
    }
  }
  send({ type: 'log', text });
  return true;
};
process.stdout.write = writeLog as typeof process.stdout.write;
process.stderr.write = writeLog as typeof process.stderr.write;
for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]) => { writeLog(`${format(...args)}\n`); };
}
setCliOptions({ ...DEFAULT_CLI_OPTIONS, progressJson: true });

async function runDreamTask(engine: BrainEngine, input: Extract<ProductTask, { type: 'dream' }>['input'], progressPrefix:string[] = []) {
  const checkpoint: MaintenanceCheckpoint = input.checkpoint ?? { phases: {}, reports: {} };
  const legacyQuickSources = input.preset === 'quick' ? [...new Set([...Object.keys(checkpoint.phases), ...Object.keys(checkpoint.reports)])].filter(sourceId => {
    const report = checkpoint.reports[sourceId];
    return (checkpoint.phases[sourceId] ?? []).some(phase => phase.phase === 'capture_entities' || phase.phase === 'embed')
      || (Array.isArray(report?.phases) && report.phases.some((phase: { phase?: string }) => phase.phase === 'capture_entities' || phase.phase === 'embed'));
  }) : [];
  if (input.preset === 'quick' || (input.phase !== 'capture_entities' && !input.incrementalIngest)) {
    retireAutomaticCapture(checkpoint);
    if (Object.keys(checkpoint.retiredCapture ?? {}).length) {
      console.log('旧版自动实体识别阶段已退出本次整理，历史结果和失败记录保留在原任务检查点。');
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
      await checkDreamBudget();
    }
  }
  for (const sourceId of legacyQuickSources) {
    const phases = checkpoint.phases[sourceId] ?? [];
    const previous = checkpoint.retiredCapture?.[sourceId];
    const report = checkpoint.reports[sourceId] ?? previous?.report;
    checkpoint.retiredCapture = { ...checkpoint.retiredCapture, [sourceId]: {
      phases: [...(previous?.phases ?? []), ...phases.filter(phase => phase.phase === 'embed')],
      ...(report ? { report } : {}),
    } };
    checkpoint.phases[sourceId] = (checkpoint.phases[sourceId] ?? []).filter(phase => phase.phase !== 'extract' && phase.phase !== 'embed');
    delete checkpoint.reports[sourceId];
  }
  const capturesImported = input.preset !== 'quick' && (!input.phase || input.phase==='all' || !!input.preset);
  const automaticEnabled=await engine.getConfig('dream.entity_capture.enabled')!=='false';
  const captureModel = input.phase === 'capture_entities' || (capturesImported && automaticEnabled) ? await chooseCaptureModel(engine, {}) : null;
  const ingestEnabled=automaticEnabled&&captureModel?.ok===true;
  let pendingFiles = false;
  let capacityReached = false;
  let scanned = 0;
  let unchanged = 0;
  const roots = new Map<string, string>();
  const fileRuntime: SyncFileRuntime | undefined = usesSyncFileQueue(input) ? {
    signal: abort.signal,
    workingTree: (await engine.getConfig('sync.include_working_tree')) === 'true',
    importFile: async (path, relativePath, options) => {
      options={...options,deferDocumentOcr:true,deferredOcrVectors:input.phase==='sync',deferredOcrMaintenanceOwnerId:input.phase==='sync'?undefined:ownerJobId??undefined};
      abort.signal.throwIfAborted();
      if(capacityReached)return {slug:'',status:'skipped',chunks:0,deferred:true};
      const sourceId = options.sourceId ?? 'default';
      if (!roots.has(sourceId)) roots.set(sourceId, (await fetchSource(engine, sourceId))?.local_path ?? '');
      const sourceRoot = roots.get(sourceId)!;
      const local = sourceRoot ? relative(sourceRoot, path) : '..';
      const originalPath = local.startsWith('..') || isAbsolute(local) ? undefined : path;
      const snapshot = await stat(path);
      let oversized=false;
      try{assertImportFileSize(relativePath,snapshot.size);}catch{oversized=true;}
      send({type:'progress',syncScan:{scanned,unchanged,path:relativePath,bytes:snapshot.size,updatedAt:new Date().toISOString(),active:true}});
      const hash = oversized?`oversize:${snapshot.size}:${snapshot.mtimeMs}`:await streamFileHash(path,abort.signal);
      const result = await rpc('task.syncFile', [{ path, relativePath, sourceRoot, originalPath,
        originalSize: snapshot.size, originalMtime: snapshot.mtimeMs, hash,
        modelFingerprint: taskModelFingerprint(),
        modelMayRun: options.documentOcr === true && (isOfficeFilePath(relativePath) || isImageFilePath(relativePath)),
        fingerprint: syncFileContentFingerprint(options),
        ...(input.preset === 'quick' ? { compatibleFingerprints: [syncFileContentFingerprint({ ...options, documentOcr: true })] } : {}), options,
      }]) as import('../../core/import-file.ts').ImportResult & { deferred?: boolean; unchanged?: boolean; capacityReached?:boolean };
      if (result.deferred) pendingFiles = true;
      if(result.capacityReached)capacityReached=true;
      scanned++;
      if (result.unchanged) unchanged++;
      send({ type: 'progress', syncScan: { scanned, unchanged,path:relativePath,bytes:snapshot.size,updatedAt:new Date().toISOString(),active:true } });
      return result;
    },
    finish: async () => { if (pendingFiles) throw new SyncFilesDeferred(); },
  } : undefined;
  const resumeOptions = async (sourceId: string) => {
    let captureEntitySlugs: string[] | undefined;
    let captureEntityBudget: import('../../core/cycle/capture-entities.ts').CaptureEntitiesOpts['budget'];
    if(capturesImported && ingestEnabled && !input.dryRun){
      captureEntitySlugs=await rpc('task.captureRequest',[sourceId]) as string[]|undefined;
      if(captureEntitySlugs)checkpoint.captureRequests={...checkpoint.captureRequests,[sourceId]:captureEntitySlugs};
    }else if(input.phase==='capture_entities'){
      captureEntitySlugs=input.slugs;
      if(input.slugs?.length&&!input.dryRun){
        captureEntitySlugs=await rpc('task.captureRequest',[sourceId,input.slugs]) as string[]|undefined??input.slugs;
        checkpoint.captureRequests={...checkpoint.captureRequests,[sourceId]:captureEntitySlugs};
      }
    }
    if (captureModel?.ok) {
      if (input.preset!=='quick'||captureEntitySlugs?.length) {
        const [usage] = await engine.executeRaw<{ input: string; output: string; unconfirmed: string }>(`SELECT COALESCE(sum(tokens_input),0) AS input,COALESCE(sum(tokens_output),0) AS output,
          COALESCE(sum(CASE WHEN data->>'capture_cost_ceiling_cny' IS NOT NULL AND (result->'tokens'->>'missing'='true' OR (result IS NULL AND EXISTS (SELECT 1 FROM subagent_messages m WHERE m.job_id=minion_jobs.id AND m.role='assistant' AND (m.tokens_in IS NULL OR m.tokens_out IS NULL))) OR ((COALESCE(tokens_input,0)=0 AND COALESCE(tokens_output,0)=0) AND result->'tokens'->>'missing' IS DISTINCT FROM 'false'))
            THEN GREATEST(0,(data->>'capture_cost_ceiling_cny')::numeric-(COALESCE(tokens_input,0)*COALESCE((data->'usage_limits'->>'input_price')::numeric,0)+COALESCE(tokens_output,0)*COALESCE((data->'usage_limits'->>'output_price')::numeric,0))/1000000) ELSE 0 END),0) AS unconfirmed
          FROM minion_jobs WHERE private_queue_owner_job_id=$1 AND data ? 'ingest_context'`, [ownerJobId]);
        const inputTokens = Number(usage?.input ?? 0), outputTokens = Number(usage?.output ?? 0);
        const cardPrices = configuredCnyPrices(captureModel.model, splitProviderModelId(captureModel.model).provider,Number(await engine.getConfig('pricing.usd_to_cny')??DEFAULT_USD_TO_CNY));
        const inputPrice = cardPrices.input;
        const outputPrice = cardPrices.output;
        const costCap = readEntityCaptureCostCap(await engine.getConfig('dream.entity_capture.cost_cap_cny'));
        captureEntityBudget = {
          costCapCny: costCap === null || inputPrice === null || outputPrice === null ? costCap : Math.max(0, costCap - Number(usage?.unconfirmed??0) - (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000),
        };
      }
    }
    for (const phase of checkpoint.phases[sourceId] ?? []) send({ type: 'progress', event: { phase: `cycle.${phase.phase}`, event: 'finish' } });
    return ({
    captureEntitySlugs,
    captureEntityBudget,
    syncFileRuntime: fileRuntime,
    completedPhases: checkpoint.phases[sourceId],
    phaseCheckpoint: async (phases: import('../../core/cycle.ts').PhaseResult[]) => {
      const capture=phases.find(phase=>phase.phase==='capture_entities');
      if(capture&&!checkpoint.phases[sourceId]?.some(phase=>phase.phase==='capture_entities')){
        const combined=mergeCaptureWindow(checkpoint.captureWindows?.[sourceId],capture);
        Object.assign(capture,combined);
        if(capture.details.window_deferred)checkpoint.captureWindows={...checkpoint.captureWindows,[sourceId]:combined};
        else if(checkpoint.captureWindows)delete checkpoint.captureWindows[sourceId];
      }
      const embed=phases.find(phase=>phase.phase==='embed');
      if(embed&&!checkpoint.phases[sourceId]?.some(phase=>phase.phase==='embed')){
        Object.assign(embed,mergeEmbeddingWindow(checkpoint.embeddingWindows?.[sourceId],embed));
        if(embed.details.vectorizationDeferred)checkpoint.embeddingWindows={...checkpoint.embeddingWindows,[sourceId]:embed};
        else if(checkpoint.embeddingWindows)delete checkpoint.embeddingWindows[sourceId];
      }
      checkpoint.phases[sourceId] = phases.filter(phase=>!phase.details.window_deferred&&!phase.details.vectorizationDeferred);
      const budget=(await import('../../core/ai/gateway')).getTaskBudgetTracker();
      if(budget?.stopReason&&checkpoint.phases[sourceId]?.length){const last=checkpoint.phases[sourceId]!.at(-1)!;last.status='warn';last.details={...last.details,task_budget_stopped:true};}
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
      await checkDreamBudget();
      if(embed?.details.vectorizationDeferred)throw new MaintenanceVectorizationDeferred();
    },
    });
  };
  const phases = input.preset === 'quick' ? resolveQuickMaintenancePhases()
    : input.phase && input.phase !== 'all' ? [input.phase]
    : resolveDreamPresetPhases(input.preset ?? 'full');
  send({ type: 'progress', phases: [...progressPrefix,...phases] });
  const phaseOptions=async(sourceId:string)=>{
    if(usesSyncFileQueue(input)&&input.phase!=='sync'&&input.preset!=='quick'){
    await engine.executeRaw(`UPDATE minion_jobs SET status='waiting',result=NULL,error_text=NULL,finished_at=NULL,data=jsonb_set(data-'ocrOwnerCancelled','{authorizedAttempt}',to_jsonb(attempts_started+1)),updated_at=now()
      WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1 AND status='cancelled' AND data->>'ocrOwnerCancelled'='true'`,[String(ownerJobId)]);
    const waiting=await engine.executeRaw("SELECT 1 FROM pages p JOIN minion_jobs j ON j.id=(p.frontmatter->>'document_ocr_task_id')::int WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.frontmatter->>'document_ocr_deferred'='true' AND (j.status IN ('waiting','active','delayed') OR j.data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$2) LIMIT 1",[sourceId,String(ownerJobId)]);
    await rpc('task.waitingOcr',[waiting.length>0]);
    if(waiting.length)throw new DocumentOcrDeferred('资料已保存，等待后台识图后继续原整理任务');
    }
    const options=await resumeOptions(sourceId);
    const selected=ALL_PHASES.filter(phase=>phases.includes(phase)||(!!options.captureEntitySlugs?.length&&phase==='capture_entities'));
    const prepareEntityCapture=capturesImported&&ingestEnabled&&!input.dryRun?async()=>{
      const slugs=await rpc('task.captureRequest',[sourceId]) as string[]|undefined;
      if(slugs)checkpoint.captureRequests={...checkpoint.captureRequests,[sourceId]:slugs};
      return slugs??[];
    }:undefined;
    if(prepareEntityCapture&&!selected.includes('capture_entities'))selected.splice(ALL_PHASES.filter(phase=>selected.includes(phase)&&ALL_PHASES.indexOf(phase)<ALL_PHASES.indexOf('capture_entities')).length,0,'capture_entities');
    send({type:'progress',phases:[...progressPrefix,...selected]});
    for (const phase of checkpoint.phases[sourceId] ?? []) send({ type: 'progress', event: { phase: `cycle.${phase.phase}`, event: 'finish' } });
    return {...options,phases:selected,prepareEntityCapture};
  };
  const sourceId = input.sourceId ? await resolveSourceId(engine, input.sourceId) : undefined;
  if (sourceId && (await fetchSource(engine, sourceId))?.archived) throw new Error(`Source ${sourceId} is archived`);
  const common = {
    afterSync: input.preset === 'quick' && !input.dryRun ? (sourceId: string, root: string, result: import('../../commands/sync.ts').SyncResult) => rpc('task.gitCommit', [sourceId, root, result]) : undefined,
    dryRun: input.dryRun, sourceId,
    captureEntitySlugs:input.slugs,
    captureEntitiesConcurrency:()=>constrained||engine.kind==='pglite'&&captureModel?.ok&&isLocalConfiguredModel(captureModel.model,loadConfig()?.desktop?.model_services??[])?1:4,
    privateQueueOwnerJobId: ownerJobId,
    signal: abort.signal,
    includeOffice: true,
    syncConcurrency: 1,
    synthInputFile: input.input,
    synthDate: input.date, synthFrom: input.from, synthTo: input.to,
    proposeTakesPageLimit: input.maxPages,
    embedPageLimit: input.maxPages,
    embedBatchSize: constrained?32:100,
    getEmbedBatchSize:()=>constrained?32:100,
    embedTimeBudgetMs: 10 * 60 * 1000,
    embedRuntime:!input.dryRun?async(sourceId?:string)=>runMaintenanceVectorization(engine,sourceId,()=>rpc('task.maintenanceVectorizationState',[]) as Promise<MaintenanceVectorizationState>,{
      pageLimit:input.maxPages,signal:abort.signal,
      onProgress:(schedule,slug,done,total)=>send({type:'progress',background:schedule,event:{phase:'embed',file:slug,stage:`${schedule.reason} · 当前资料 ${done}/${total} 段已保存`}}),
    }):undefined,
    proposeTakesRequireChunks: true,
    proposeTakesDrain: input.drainProposals,
    proposeTakesWindowMs: (input.windowSeconds ?? 3600) * 1000,
    yieldBetweenPhases:async()=>{await yieldExecution();if(constrained)Bun.gc(false);},
    yieldDuringPhase:async()=>{abort.signal.throwIfAborted();await yieldExecution();if(constrained)Bun.gc(false);},
  };
  if (input.preset === 'quick') console.log('快速维护仅同步变化并关联已有实体；新实体建档、图片识别和向量化不属于本次维护。');
  if (input.preset === 'quick' && input.allSources) {
    const reports = [];
    const startedAt = new Date();
    const sources = (await loadAllSources(engine)).filter(row => parseSourceConfig(row.config).syncEnabled !== false);
    for (const [index, source] of sources.entries()) {
      abort.signal.throwIfAborted();
      if (checkpoint.reports[source.id]) {
        reports.push({ sourceId: source.id, report: checkpoint.reports[source.id] as unknown as import('../../core/cycle.ts').CycleReport });
        continue;
      }
      scanned=0;unchanged=0;pendingFiles=false;capacityReached=false;
      send({ type: 'progress', scope: { name: source.name, index, total: sources.length } });
      const report = await runQuickMaintenance(engine, {
        ...common, sourceId: source.id, brainDir: await resolveBrainDir(engine, null, source.id),
        ...await phaseOptions(source.id),
      });
      if (report.reason === 'cycle_already_running') return report;
      checkpoint.reports[source.id] = { ...report };
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
      reports.push({ sourceId: source.id, report });
      if (report.phases.some(phase => phase.status === 'fail' && isGinRepairAbortText(`${phase.error?.message ?? ''}\n${phase.summary}\n${JSON.stringify(phase.details ?? {})}`))) break;
    }
    return combineQuickMaintenanceReports(reports, startedAt);
  }
  const brainDir = await resolveBrainDir(engine, null, sourceId);
  if (input.preset === 'quick') return runQuickMaintenance(engine, { ...common, brainDir, ...await phaseOptions(sourceId ?? 'default') });
  const dreamKnowledge=await import('./dream-knowledge');
  const knowledgeEnabled=input.preset==='full'&&await dreamKnowledge.prepareDreamKnowledge(engine);
  if(input.preset==='full'&&!input.dryRun)await dreamKnowledge.prepareProductEnrichThin(engine);
  const currentPack=loadConfig()?.schema_pack??'gbrain-base';
  const knowledgePack=knowledgeEnabled?(currentPack==='gbrain-base-v2'?'pmbrain-knowledge':currentPack==='gbrain-base'?'gbrain-creator':undefined):undefined;
  const report=await runCycle(engine, {
    ...resolveDreamRelationOptions(input.preset, input.phase),
    ...common, brainDir,
    ...await phaseOptions(sourceId ?? 'default'),
    quickEntitiesOnly: input.preset === 'full',
    reuseDuplicateKnowledgeSources: input.preset === 'full',
    schemaPack:knowledgePack,
    includePendingKnowledge:knowledgeEnabled,
    forcePackPhases: input.preset === 'meeting' ? ['extract_atoms'] : undefined,
    ...(input.preset==='full'?{enrichThinWhenUnset:true,enrichThinTypesWhenUnset:['person','company','project']}:{}),
  });
  if(input.phase==='capture_entities'&&input.incrementalIngest&&!progressPrefix.length&&!input.dryRun){
    const details=report.phases.find(phase=>phase.phase==='capture_entities')?.details;
    const strip=(slug:string)=>slug.startsWith((sourceId??'default')+':')?slug.slice((sourceId??'default').length+1):slug;
    const slugs=(key:string)=>[...new Set((Array.isArray(details?.[key])?details[key] as string[]:[]).map(strip).filter(slug=>slug.length>0&&!slug.includes(':')))];
    await rpc('task.searchOptimizeCaptured',[sourceId??'default',slugs('written_slugs'),slugs('source_slugs')]);
  }
  return report;
}

async function runSearchOptimize(engine: BrainEngine): Promise<void> {
  let stalePageAttempts = 0;
  let schedule: VectorizationSchedule | undefined;
  let lastBatchAt = 0;
  const windowEndsAt = Date.now() + 60000;
  for (;;) {
    abort.signal.throwIfAborted();
    const state = await rpc('task.searchOptimizeState', []) as {
      paused?: boolean;
      done?: number;
      total?: number;
      items?: Array<{ sourceId?: string; slug?: string; revision?: string }>;
      schedule?: VectorizationSchedule;
    };
    schedule = state.schedule;
    const items = Array.isArray(state.items)
      ? state.items.filter((item): item is { sourceId: string; slug: string; revision?: string } => Boolean(item?.sourceId && item.slug && !item.slug.includes(':')))
      : [];
    const done = Number.isFinite(state.done) ? Number(state.done) : 0;
    if (!items.length) {
      await rpc('task.searchOptimizeRelease', []);
      const total = Math.max(done, Number.isFinite(state.total) ? Number(state.total) : done);
      send({ type: 'progress', event: { phase: 'embed', event: 'finish', done, total, unit: '份资料' } });
      send({ type: 'result', result: { searchOptimize: true, status: 'ok' } });
      return;
    }
    if (state.paused || schedule?.mode === 'waiting' || Date.now() >= windowEndsAt) {
      send({ type: 'deferred', phase: 'search_optimize' });
      return;
    }
    const next = items[0]!;
    const [ocrPending]=await engine.executeRaw("SELECT 1 FROM pages WHERE slug=$1 AND source_id=$2 AND deleted_at IS NULL AND frontmatter->>'document_ocr_deferred'='true'",[next.slug,next.sourceId]);
    if(ocrPending){send({type:'deferred',phase:'search_optimize'});return;}
    const revision = next.revision;
    const total = Number.isFinite(state.total) ? Number(state.total) : done + items.length;
    send({ type: 'progress', background: schedule, event: { phase: 'embed', done, total, unit: '份资料', stage: schedule?.reason, file: next.slug } });
    await rpc('task.searchOptimizeForgetPage', [next.sourceId, next.slug]);
    let embedded: Awaited<ReturnType<typeof runEmbedCore>>;
    try {
      embedded = await runEmbedCore(engine, {
        slugs: [next.slug],
        sourceId: next.sourceId,
        batchSize: 32,
        getBatchSize: () => Math.min(constrained ? 4 : 32, schedule?.batchSize || 4),
        writeBatchSize: engine.kind === 'pglite' ? 1 : 4,
        quiet: true,
        signal: abort.signal,
        pauseCheck: async () => {
          const delay = (schedule?.delayMs ?? 0) - (Date.now() - lastBatchAt);
          if (delay > 0) await waitForBatch(delay, undefined, { signal: abort.signal });
          const current = await rpc('task.searchOptimizeState', []) as { paused?: boolean; schedule?: VectorizationSchedule };
          schedule = current.schedule;
          return Boolean(current.paused || schedule?.mode === 'waiting' || Date.now() >= windowEndsAt);
        },
        onProgress: (processed, chunks) => {
          lastBatchAt = Date.now();
          send({ type: 'progress', background: schedule, event: { phase: 'embed', done, total, unit: '份资料', file: next.slug, stage: `${schedule?.reason ?? '正在向量化'} · 当前资料 ${processed}/${chunks} 段已保存` } });
        },
      });
    } catch (error) {
      if (abort.signal.aborted) {
        const reason = abort.signal.reason;
        throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'service_shutdown: 本地服务关闭');
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('在处理期间已改变') && stalePageAttempts < 3) {
        stalePageAttempts += 1;
        continue;
      }
      if (vectorizationRetryDelay(message, 0) !== null) {
        send({ type: 'deferred', phase: 'search_optimize', error: message });
        return;
      }
      throw error;
    }
    stalePageAttempts = 0;
    if (abort.signal.aborted) {
      const reason = abort.signal.reason;
      throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'service_shutdown: 本地服务关闭');
    }
    if (embedded.incomplete) {
      send({ type: 'deferred', phase: 'search_optimize' });
      return;
    }
    if (embedded.error || embedded.failedPages > 0 || embedded.status === 'failed') {
      const message = embedded.error || '知识向量化未完成';
      if (vectorizationRetryDelay(message, 0) !== null) {
        send({ type: 'deferred', phase: 'search_optimize', error: message });
        return;
      }
      send({ type: 'error', error: message, result: { searchOptimize: true, status: 'failed', failures: [{ error: message }] } });
      return;
    }
    await rpc('task.searchOptimizeDone', revision ? [next.sourceId, next.slug, revision] : [next.sourceId, next.slug]);
  }
}

async function execute(task:ProductTask,kind:BrainEngine['kind']){
  if(task.type!=='sync-file')return executeTask(task,kind);
  const tracker=await openTaskBudget(request=>rpc('task.budget',[request]) as Promise<TaskBudgetReply>);
  return tracker?withTaskBudgetTracker(tracker,()=>executeTask(task,kind)):executeTask(task,kind);
}
async function executeTask(task: ProductTask, kind: BrainEngine['kind']) {
  const engine = proxyEngine(kind);
  if (loadConfig()) await reloadLiveGateway(engine);
  let result: Record<string, unknown>;
  if (task.type === 'sync-file') {
    const input = task.input;
    if ((input.modelMayRun || !input.options.noEmbed) && input.modelFingerprint !== taskModelFingerprint()) throw new Error('模型配置已改变，请继续同步以重新扫描');
    const source = await fetchSource(engine, input.options.sourceId ?? 'default');
    if (!source || source.archived || source.local_path !== input.sourceRoot) throw new Error('Source 路径已改变或已归档，请重新扫描');
    const { SyncFileQueue } = await import('./sync-file-queue.ts');
    await new SyncFileQueue(engine).validate(input);
    const snapshot = await stat(input.originalPath ?? input.path);
    importFile = input.relativePath;
    send({type:'progress',event:{phase:'import.process',file:importFile}});
    await rpc('task.inputFile', [{ path: input.originalPath ?? input.path, size: snapshot.size, mtimeMs: snapshot.mtimeMs }]);
    try {
      const imported = await importSyncFile(engine, input.path, input.relativePath, {...input.options,ocrOriginalPath:input.originalPath??null},new DocumentRuntime({signal:abort.signal,sample:()=>rpc('task.documentResources',[]) as Promise<DocumentResourceSample>}));
      abort.signal.throwIfAborted();
      const page = imported.slug ? await engine.getPage(imported.slug, { sourceId: input.options.sourceId }) : null;
      const manifest=page?await readDocumentChunkManifest(engine,page.id):undefined;
      result = { slug: imported.slug, status: imported.error && imported.error !== 'unchanged' ? 'failed' : imported.status, chunks: imported.chunks,
        error: imported.error, documentSummary: imported.documentSummary, largeDocument: imported.largeDocument,ocrPending:imported.ocrPending,ocrTaskId:imported.ocrTaskId,
        pageHash: page?.content_hash, chunkHash:manifest?.chunk_hash, file: input.relativePath };
    } catch (error) {
      abort.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (isInfrastructureFailureCode(classifyErrorCode(message)) || /租约|Source|配置|处理期间已改变|快照已改变|SQL|constraint|database/i.test(message)) throw error;
      result = { slug: '', status: 'failed', chunks: 0, error: message, file: input.relativePath };
    }
    send({ type: 'result', result });
    return;
  } else if(task.type==='import'&&task.input.ocrOnly){
    const input=task.input,expected=input.ocrOnly!,sourceId=input.sourceId??'default';
    const runtime=new class extends DocumentRuntime{
      private checked=0;
      override async checkpoint(force=false){
        if(force||Date.now()-this.checked>1000){
          this.checked=Date.now();const schedule=await rpc('task.documentOcrSchedule',[]) as VectorizationSchedule;
          if(schedule.mode==='waiting')throw new DocumentOcrDeferred(schedule.reason);
          await validateDeferredDocument(engine,input.path,sourceId,expected,this,false);
        }
        await super.checkpoint(force);
      }
    }({signal:abort.signal,sample:()=>rpc('task.documentResources',[]) as Promise<DocumentResourceSample>});
    const work=async()=>{
    send({type:'progress',phases:['ocr'],event:{phase:'ocr',event:'start',stage:'后台补齐图片文字',file:expected.relativePath}});
    await runtime.checkpoint(true);
    await validateDeferredDocument(engine,input.path,sourceId,expected,runtime);
    const imported=expected.image?await (await import('../../core/import-file')).importImageFile(engine,input.path,expected.relativePath,{sourceId,noEmbed:true,forceOcr:true,runtime,storagePath:expected.ownedSnapshot?input.path:undefined,validate:target=>validateDeferredDocument(target,input.path,sourceId,expected,runtime)}):await (await import('../../core/office-import')).importOfficeFile(engine,input.path,expected.relativePath,{sourceId,noEmbed:true,documentOcr:true,runtime});
    if(imported.status==='partial'||imported.status==='error'||imported.error||Number(imported.documentSummary?.ocrFailed)>0||Number(imported.documentSummary?.ocrSkipped)>0)throw new Error(imported.error??imported.documentSummary?.ocrWarnings.join('；')??'图片识别尚未完成，已保存的内容保留');
    const output:Record<string,unknown>={status:'completed',imported:imported.status==='imported'?1:0,skipped:imported.status==='skipped'?1:0,errors:0,ocrPending:0};
    if(!input.noEmbed){output.embedSlugs=[imported.slug];output.embedSourceId=sourceId;assignSearchOptimizeAcceptance(output,await rpc('task.searchOptimize',[sourceId,[imported.slug]]) as SearchOptimizeAcceptance);}
    await cleanupDeferredDocument(input.path,expected);
    send({type:'progress',event:{phase:'ocr',event:'finish',stage:'图片识别完成'}});
    return output;
    };
    result=expected.maintenanceOwnerId?await runWithDreamBudget({},work,request=>rpc('task.budget',[request]) as Promise<TaskBudgetReply>):await work();
  } else if (task.type === 'memory') {
    send({type:'progress',phases:['memory']});send({type:'progress',event:{phase:'memory',event:'start'}});
    const { runWorkbenchMemoryTask } = await import('../workbench/memory');
    const synthEnabled=await engine.getConfig('dream.synthesize.enabled');
    const synthConfigured=synthEnabled==='true'||synthEnabled!=='false'&&!!await engine.getConfig('dream.synthesize.session_corpus_dir');
    result = await runWorkbenchMemoryTask(engine, task.input, abort.signal, { ownerJobId,ownerToken,organize:synthConfigured?async(path,sourceId)=>{
      const report=await runDreamTask(engine,{phase:'synthesize',input:path,sourceId,checkpoint:task.input.knowledgeCheckpoint});
      const failure=maintenanceFailure(report);
      if(failure)throw new Error(failure);
      if(report.reason==='cycle_already_running')throw new Error('当前 Source 正在整理，记忆事实已保留，请稍后继续整理');
      return report;
    }:undefined });
    send({type:'progress',event:{phase:'memory',event:'finish'}});
  } else if (task.type === 'import') {
    const input = task.input;
    const vectorsRequested = input.noEmbed !== true;
    const sourceId = input.sourceId ?? 'default';
    const filePhases = ['collect', 'process', 'write'];
    send({ type: 'progress', phases: filePhases });
    send({ type: 'progress', event: { phase: 'import.collect' } });
    const completedPaths: string[] = [];
    const resumedVectorSlugs: string[] = [];
    if (input.resumeCheckpointId) {
      for (const file of await readTaskCheckpoint(input.resumeCheckpointId)) {
        if (file.completed !== true || file.modelFingerprint !== taskModelFingerprint()) continue;
        const current = await stat(String(file.absolutePath)).catch(() => null);
        if (current?.size === file.size && typeof file.hash==='string' && await streamFileHash(String(file.absolutePath),abort.signal)===file.hash) {
          completedPaths.push(String(file.path));
          const slug = typeof file.slug === 'string' ? file.slug : '';
          if (vectorsRequested && file.vectorize === true && slug.length > 0 && !slug.includes(':')) resumedVectorSlugs.push(slug);
          await rpc('task.checkpoint', [file]);
        }
      }
    }
    if (vectorsRequested && resumedVectorSlugs.length) await rpc('task.searchOptimize', [sourceId, [...new Set(resumedVectorSlugs)]]);
    let fileSnapshot: Record<string, unknown> = {};
    const imported = await runStructuredImport(engine, {
      path: input.path, noEmbed: true, fresh: true, jsonOutput: true, reportFiles: true,
      includeOffice: input.includeOffice !== false,
      includeImages: input.includeImages !== false,
      documentOcr: input.documentOcr !== false,
      deferDocumentOcr:true,deferredOcrVectors:vectorsRequested,transientDocumentSource:!!input.stagingDir,
      structuredDocuments: input.structuredDocuments,
    }, {
      sourceId: input.sourceId,
      documentRuntime:new DocumentRuntime({signal:abort.signal,sample:()=>rpc('task.documentResources',[]) as Promise<DocumentResourceSample>}),
      runtime: {
        signal: abort.signal,
        completedPaths,
        beforeFile: async path => {
          importFile = path;
          send({ type: 'progress', event: { phase: 'import.process', file: path } });
          const file = await stat(path);
          fileSnapshot = { absolutePath: path, size: file.size, mtimeMs: file.mtimeMs, hash:await streamFileHash(path,abort.signal), modelFingerprint: taskModelFingerprint() };
          try {
            await rpc('task.inputFile', [{ path, size: file.size, mtimeMs: file.mtimeMs }]);
          } catch (error) {
            if (!isOversizedImportError(error)) throw error;
            return error instanceof Error ? error.message : String(error);
          }
        },
        onFile: async progress => {
          send({ type: 'progress', event: { phase: 'import.files', done: Number(progress.processed) } });
          importFile = undefined;
          const slug = typeof progress.slug === 'string' ? progress.slug : '';
          if (vectorsRequested && progress.vectorize === true && slug.length > 0 && !slug.includes(':')) {
            await rpc('task.searchOptimize', [sourceId, [slug]]);
          }
          await rpc('task.checkpoint', [{ ...progress, ...fileSnapshot }]);
        },
      },
    });
    const embedSlugs=[...new Set((imported.importedSlugs??[]).filter(slug=>slug.length>0&&!slug.includes(':')))];
    result = { ...imported, resumedFiles: completedPaths.length };
    if(vectorsRequested&&embedSlugs.length){
      result.embedSlugs=embedSlugs;
      result.embedSourceId=sourceId;
      try{
        assignSearchOptimizeAcceptance(result, await rpc('task.searchOptimize',[sourceId,embedSlugs]) as SearchOptimizeAcceptance);
      }catch(error){
        if(abort.signal.aborted)throw error;
        result.searchOptimizeError=true;
      }
    }
  } else if (task.type === 'dream') {
    result = await runWithDreamBudget(task.input,async()=>({...await runDreamTask(engine,task.input)}),request=>rpc('task.budget',[request]) as Promise<TaskBudgetReply>);
  } else if (task.type === 'sync') {
    const results = [];
    const gateway = await import('../../core/ai/gateway.ts');
    for (const source of (await loadAllSources(engine)).filter(row => row.local_path && parseSourceConfig(row.config).syncEnabled !== false)) {
      abort.signal.throwIfAborted();
      results.push(await performSync(engine, {
        sourceId: source.id, repoPath: source.local_path!,
        concurrency: 1, signal: abort.signal, noEmbed:true,
        fileRuntime:{
          signal:abort.signal,
          importFile:async(path,relativePath,options)=>{
            const local=relative(source.local_path!,path);
            const imported=await importSyncFile(engine,path,relativePath,{...options,deferDocumentOcr:true,deferredOcrVectors:true,ocrOriginalPath:local.startsWith('..')||isAbsolute(local)?null:path},new DocumentRuntime({signal:abort.signal,sample:()=>rpc('task.documentResources',[]) as Promise<DocumentResourceSample>}));
            if(!imported.ocrPending&&imported.slug&&(['imported','partial'].includes(imported.status)||imported.status==='skipped'&&!imported.error)){
              const [pending]=await engine.executeRaw('SELECT 1 FROM pages p JOIN content_chunks c ON c.page_id=p.id WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL AND c.embedding IS NULL LIMIT 1',[source.id,imported.slug]);
              if(pending)await rpc('task.searchOptimize',[source.id,[imported.slug]]);
            }
            return imported;
          },
          finish:async()=>{},
        },
        strategy: parseSourceConfig(source.config).strategy as SyncStrategy | undefined,
        includeOffice: parseSourceConfig(source.config).includeOffice === true,
        includeImages: gateway.isOcrEnabled(), documentOcr: gateway.isOcrEnabled(),
      }));
    }
    result = { results, errors: results.filter(row => ['blocked_by_failures', 'partial'].includes(row.status)).length };
  } else if (task.type === 'assistant') {
    throw new Error('助手任务由工作台执行器处理');
  } else if (task.input.searchOptimize === true) {
    await runSearchOptimize(engine);
    return;
  } else {
    const embed=task.input;
    send({ type: 'progress', event: { phase: 'embed', event: 'start', stage: '正在调用向量模型', unit: '段' } });
    const embedded=await runEmbedCore(engine, {
      stale: !embed.slugs?.length, slugs: embed.slugs, sourceId: embed.sourceId,
      forceReembed: embed.forceReembed,
      catchUp: embed.catchUp,
      batchSize: 100,
      getBatchSize:()=>constrained?32:100,
      signal: abort.signal,
    });
    result = { ...embedded, catchUp: embed.catchUp === true, forceReembed: embed.forceReembed === true, ...(embedded.error ? { failures: [{ error: embedded.error }] } : {}) };
  }
  abort.signal.throwIfAborted();
  if(task.type==='dream'||task.type==='sync'){
    const scope=task.type==='dream'&&!task.input.allSources?task.input.sourceId??'default':null;
    const pending=await engine.executeRaw<{id:number;remaining:number}>(`SELECT (frontmatter->>'document_ocr_task_id')::int id,COALESCE((frontmatter->>'document_ocr_failed')::int,0)+COALESCE((frontmatter->>'document_ocr_skipped')::int,0) remaining FROM pages WHERE deleted_at IS NULL AND ($1::text IS NULL OR source_id=$1) AND frontmatter->>'document_ocr_deferred'='true' AND frontmatter ? 'document_ocr_task_id'`,[scope]);
    if(pending.length){result.ocrPending=pending.reduce((sum,row)=>sum+row.remaining,0);result.ocrTaskIds=[...new Set(pending.map(row=>row.id))];}
  }
  const failure = task.type === 'dream' || task.type==='import' ? maintenanceFailure(result) : null;
  if (result.reason === 'cycle_already_running') send({ type: 'result', result });
  else if (failure || result.status === 'failed' || Number(result.errors ?? 0) > 0) {
    const failures = result.failures as Array<{ error: string }> | undefined;
    const phases = result.phases as Array<{ error?: { message?: string }; status?: string; summary?: string }> | undefined;
    const phase = phases?.find(row => row.status === 'fail');
    send({ type: 'error', error: result.reason==='task_budget'?String(result.summary):failure ?? failures?.[0]?.error ?? phase?.error?.message ?? phase?.summary ?? `任务未全部完成：${result.errors ?? result.status}`, result });
  } else {
    send({ type: 'result', result });
  }
}

parentPort!.on('message', message => {
  if(message.type==='resource-pressure'){
    constrained=message.constrained===true;
    if(constrained)Bun.gc(false);
  }else if (message.type === 'reply') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      if(resourceProtectionAbortsTask(message.error))abort.abort(new Error(message.error));
      waiter?.reject(new Error(message.error));
    }
    else waiter?.resolve(message.value);
  } else if (message.type === 'cancel') {
    const reason=typeof message.reason==='string'?message.reason:'user_stop: 任务已取消';
    abort.abort(new Error(reason));
    for (const waiter of pending.values()) waiter.reject(new Error(reason));
    pending.clear();
  } else if (message.type === 'start') {
    ownerJobId = Number.isSafeInteger(message.ownerJobId) ? message.ownerJobId : null;
    ownerToken=typeof message.ownerToken==='string'?message.ownerToken:undefined;
    constrained=message.constrained===true;
    abort = new AbortController();
    importFile = undefined;
    backgroundDocumentOcr=message.task.type==='import'&&!!message.task.input.ocrOnly;
    void execute(message.task, message.kind).catch(error => {
      if(error instanceof DocumentOcrDeferred){send({type:'deferred',phase:message.task.type==='dream'?'maintenance_ocr':'document_ocr'});return;}
      if(error instanceof MaintenanceVectorizationDeferred){send({type:'deferred',phase:'maintenance_embed'});return;}
      if(error instanceof EntityCaptureWindowDeferred){send({type:'deferred',phase:'capture_entities'});return;}
      if (error instanceof SyncFilesDeferred) { send({ type: 'deferred' }); return; }
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    });
  }
});
