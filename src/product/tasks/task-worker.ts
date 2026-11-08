import type { BrainEngine } from '../../core/engine.ts';
import type { ProductTask, TaskWorkerMessage, MaintenanceCheckpoint } from './types.ts';
import {DocumentOcrDeferred,validateDeferredDocument,cleanupDeferredDocument} from '../../core/pmbrain-adapters/deferred-document-ocr';
import { loadConfig } from '../../core/config.ts';
import { reloadLiveGateway } from '../../core/ai/reload-live-gateway.ts';
import { DEFAULT_CLI_OPTIONS, setCliOptions } from '../../core/cli-options.ts';
import { runStructuredImport, importSyncFile } from '../../commands/import.ts';
import { runCycle, ALL_PHASES, extractTotals, deriveStatus, syncPhasePages, type CyclePhase, type CycleReport } from '../../core/cycle.ts';
import { resolveDreamPresetPhases, resolveDreamRelationOptions, resolveBrainDir } from '../../commands/dream.ts';
import { runQuickMaintenance, combineQuickMaintenanceReports, resolveQuickMaintenancePhases } from '../../core/quick-maintenance.ts';
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
import { EmbedPreflightSession, runEmbedCore } from '../../commands/embed.ts';
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
import { readTaskCheckpoint, taskModelFingerprint, syncFileContentFingerprint, syncFileCompatibleFingerprints, retireAutomaticCapture } from './checkpoint.ts';
import { DeepOutputReceipt } from './deep-output-receipt';
import { loadAllowedSlugPrefixes } from '../../core/cycle/allowed-slug-prefixes';
import { phaseHasPendingWork } from '../../../shared/dream-phase-state.ts';
import { usesSyncFileQueue } from '../../../shared/task-progress.ts';
import { isGinRepairAbortText } from '../../core/pglite-gin-repair.ts';
import type { SyncStrategy } from '../../core/sync.ts';
import { isOfficeFilePath, resolveSlugForPath } from '../../core/sync.ts';
import { isImageFilePath } from '../../core/import-file.ts';
import { QuickSyncPlan } from './quick-sync-plan';
import { DEEP_ORGANIZE_STAGES, deepOrganizePhaseNames, isStagedDeepOrganize, summarizeDeepStage, type DeepRoundProgress } from '../../../shared/deep-organize-progress';
import { DEEP_ORGANIZE_PHASE_HORIZON_MS } from './timeout.ts';
import { classifyQuickScanHash, classifyQuickScanStat } from './quick-scan-index';
import type { MaintenanceRoundProgress, MaintenanceStageId, MaintenanceStageResult } from '../../../shared/maintenance-progress';
import {QuickVectorProgress} from './vector-progress';
import {importOutcome} from '../../../shared/import-outcome';

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
  const stagedFull = isStagedDeepOrganize(input);
  let deepOutput: DeepOutputReceipt | undefined;
  const checkpoint: MaintenanceCheckpoint = input.checkpoint ?? { phases: {}, reports: {} };
  const round: MaintenanceRoundProgress = checkpoint.quickProgress ?? { scan: { scanned: 0, unchanged: 0, complete: false }, stage: 'sync', stages: [], entities: { total: 0, person: 0, project: 0, organization: 0, company: 0, links: 0 } };
  const notifyRound = () => { checkpoint.quickProgress=round; send({type:'maintenance',value:round}); };
  const deepRound: DeepRoundProgress | undefined = stagedFull ? checkpoint.deepProgress ?? { stage: 'check', stages: [], scan: { scanned: 0, unchanged: 0, complete: false } } : undefined;
  const notifyDeep = () => { if (!deepRound) return; checkpoint.deepProgress = deepRound; send({ type: 'deep', value: deepRound }); };
  const syncPlan = ((input.preset==='quick' || stagedFull) && !input.dryRun) ? new QuickSyncPlan(checkpoint,()=>rpc('task.maintenanceCheckpoint',[checkpoint]),scan=>{
    if (input.preset==='quick') { round.scan=scan; notifyRound(); }
    if (deepRound) { deepRound.scan=scan; if (deepRound.stage==='sync') deepRound.current={...deepRound.current,result:`已扫描 ${scan.scanned}，未变化 ${scan.unchanged}`}; notifyDeep(); }
  },ownerJobId) : undefined;
  const quickPlan = input.preset==='quick' ? syncPlan : undefined;
  let pauseForDocumentOcr = true;
  const legacyQuickSources = input.preset === 'quick' ? [...new Set([...Object.keys(checkpoint.phases), ...Object.keys(checkpoint.reports)])].filter(sourceId => {
    const report = checkpoint.reports[sourceId];
    return (checkpoint.phases[sourceId] ?? []).some(phase => phase.phase === 'capture_entities' || phase.phase === 'embed')
      || (Array.isArray(report?.phases) && report.phases.some((phase: { phase?: string }) => phase.phase === 'capture_entities' || phase.phase === 'embed'));
  }) : [];
  const legacyCompletedReports = new Set<string>();
  if (input.preset === 'quick' && input.allSources && checkpoint.quickSync) {
    for (const [id, raw] of Object.entries(checkpoint.reports)) {
      const report = raw as { status?: string; brain_dir?: string | null; phases?: Array<{ status?: string }> };
      const plan = checkpoint.quickSync.sources[id];
      if ((plan && !(plan.complete && plan.paths.length === 0 && plan.entries.length === 0)) || report.status === 'failed' || report.phases?.some(phase => phase.status === 'fail')) continue;
      checkpoint.quickSync.sources[id] ??= {
        root: report.brain_dir ?? '', paths: [], checked: 0, checkedPaths: [], unchanged: 0, entries: [], complete: true,
      };
      legacyCompletedReports.add(id);
    }
  }
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
      phases: [...(previous?.phases ?? []), ...phases.filter(phase => phase.phase === 'capture_entities' || phase.phase === 'embed')],
      ...(report ? { report } : {}),
    } };
    checkpoint.phases[sourceId] = (checkpoint.phases[sourceId] ?? []).filter(phase => phase.phase !== 'capture_entities' && phase.phase !== 'embed');
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
    get collectOnly(){return syncPlan?.preparing;},
    listFiles: syncPlan ? async (root,discover)=>{
      const paths=await syncPlan.list(root,discover);
      if(syncPlan.preparing&&!syncPlan.current?.complete){
        const sourceRoot=(await fetchSource(engine,syncPlan.sourceId))?.local_path??'';
        await syncPlan.loadFingerprints(engine,sourceRoot,root,paths);
      }
      return paths;
    } : undefined,
    importFiles: syncPlan ? ()=>syncPlan.imports() : undefined,
    workingTree: input.preset === 'quick' || stagedFull || (await engine.getConfig('sync.include_working_tree')) === 'true',
    importFile: async (path, relativePath, options) => {
      if(syncPlan&&!syncPlan.preparing){
        const file=syncPlan.file(path);
        if(!file)throw new Error('资料不属于本轮固定清单');
        const result=await rpc('task.syncFile',[file]) as import('../../core/import-file.ts').ImportResult & {deferred?:boolean};
        if(result.deferred)pendingFiles=true;
        return result;
      }
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
      if(syncPlan?.preparing){
        const fingerprint=syncFileContentFingerprint(options);
        const compatible=syncFileCompatibleFingerprints(options,relativePath);
        const base: import('./types').SyncFileInput = { path, relativePath, sourceRoot, originalPath,
          originalSize: snapshot.size, originalMtime: snapshot.mtimeMs, originalCtime: snapshot.ctimeMs, hash: '',
          quickMaintenance:true, modelFingerprint: taskModelFingerprint(),
          modelMayRun: options.documentOcr === true && (isOfficeFilePath(relativePath) || isImageFilePath(relativePath)),
          fingerprint, compatibleFingerprints: compatible, options,
        };
        const remember=async(file: import('./types').SyncFileInput, fileUnchanged: boolean)=>{
          const known=syncPlan!.stored(sourceRoot,relativePath);
          const prepared=!fileUnchanged&&(known?.repairRequired||(!isOfficeFilePath(relativePath)&&!known?.chunkHash))?{...file,options:{...file.options,forceRechunk:true}}:file;
          await syncPlan!.record(prepared,fileUnchanged);
          scanned++; if(fileUnchanged)unchanged++;
          send({type:'progress',syncScan:{scanned,unchanged,path:relativePath,bytes:snapshot.size,updatedAt:new Date().toISOString(),active:true}});
          return {slug:'',status:'skipped' as const,chunks:0,deferred:true};
        };
        if(oversized)return remember({...base,hash:`oversize:${snapshot.size}:${snapshot.mtimeMs}`},false);
        const stored=syncPlan!.stored(sourceRoot,relativePath);
        const statDecision=classifyQuickScanStat(stored,snapshot.size,snapshot.mtimeMs,fingerprint,compatible,snapshot.ctimeMs);
        if(statDecision==='unchanged')return remember({...base,hash:stored!.hash},true);
        if(statDecision==='same-bytes')return remember({...base,hash:stored!.hash},false);
        const hash=await streamFileHash(path,abort.signal);
        const hashed=classifyQuickScanHash(stored,hash,fingerprint,compatible,snapshot.size,snapshot.mtimeMs,snapshot.ctimeMs);
        if(hashed.unchanged&&!stored?.repairRequired){
          if(hashed.refresh)syncPlan!.noteRefresh(sourceRoot,relativePath,snapshot.size,snapshot.mtimeMs,snapshot.ctimeMs);
          return remember({...base,hash},true);
        }
        return remember({...base,hash},false);
      }
      const hash = oversized?`oversize:${snapshot.size}:${snapshot.mtimeMs}`:await streamFileHash(path,abort.signal);
      const file: import('./types').SyncFileInput = { path, relativePath, sourceRoot, originalPath,
        originalSize: snapshot.size, originalMtime: snapshot.mtimeMs, originalCtime: snapshot.ctimeMs, hash,
        quickMaintenance:input.preset==='quick',
        modelFingerprint: taskModelFingerprint(),
        modelMayRun: options.documentOcr === true && (isOfficeFilePath(relativePath) || isImageFilePath(relativePath)),
        fingerprint: syncFileContentFingerprint(options),
        ...((input.preset === 'quick' || stagedFull) ? { compatibleFingerprints: syncFileCompatibleFingerprints(options,relativePath) } : {}), options,
      };
      const result=await rpc('task.syncFile',[file]) as import('../../core/import-file.ts').ImportResult & { deferred?: boolean; unchanged?: boolean; capacityReached?:boolean;preparedFile?:import('./types').SyncFileInput };
      if (result.deferred) pendingFiles = true;
      if(result.capacityReached)capacityReached=true;
      scanned++;
      if (result.unchanged) unchanged++;
      send({ type: 'progress', syncScan: { scanned, unchanged,path:relativePath,bytes:snapshot.size,updatedAt:new Date().toISOString(),active:true } });
      return result;
    },
    finish: async () => { if(syncPlan?.preparing){await syncPlan.flushRefreshes(engine);await syncPlan.finish();throw new SyncFilesDeferred();} if (pendingFiles) throw new SyncFilesDeferred(); },
  } : undefined;
  const resumeOptions = async (sourceId: string) => {
    let captureEntitySlugs: string[] | undefined;
    let captureEntityBudget: import('../../core/cycle/capture-entities.ts').CaptureEntitiesOpts['budget'];
    if(capturesImported && ingestEnabled && !input.dryRun && !stagedFull){
      captureEntitySlugs=await rpc('task.captureRequest',[sourceId]) as string[]|undefined;
      if(captureEntitySlugs)checkpoint.captureRequests={...checkpoint.captureRequests,[sourceId]:captureEntitySlugs};
    }else if(stagedFull){
      captureEntitySlugs=checkpoint.captureRequests?.[sourceId];
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
      if (deepOutput && phases.length) {
        const last = phases.at(-1)!;
        if (!checkpoint.phases[sourceId]?.some(saved => saved.phase === last.phase)) last.details = { ...last.details, ...deepOutput.take() };
      }
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
    if(pauseForDocumentOcr&&usesSyncFileQueue(input)&&input.phase!=='sync'&&input.preset!=='quick'){
    await engine.executeRaw(`UPDATE minion_jobs SET status='waiting',result=NULL,error_text=NULL,finished_at=NULL,data=jsonb_set(data-'ocrOwnerCancelled','{authorizedAttempt}',to_jsonb(attempts_started+1)),updated_at=now()
      WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1 AND status='cancelled' AND data->>'ocrOwnerCancelled'='true'`,[String(ownerJobId)]);
    const waiting=await engine.executeRaw(input.preset==='full'
      ? "SELECT 1 FROM pages p JOIN minion_jobs j ON j.id=(p.frontmatter->>'document_ocr_task_id')::int WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.frontmatter->>'document_ocr_deferred'='true' AND j.data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$2 AND j.status IN ('waiting','active','delayed','paused','failed','dead') LIMIT 1"
      : "SELECT 1 FROM pages p JOIN minion_jobs j ON j.id=(p.frontmatter->>'document_ocr_task_id')::int WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.frontmatter->>'document_ocr_deferred'='true' AND (j.status IN ('waiting','active','delayed') OR j.data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$2) LIMIT 1",[sourceId,String(ownerJobId)]);
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
  const quickBrainDir = async (id?: string) => (id ? (await fetchSource(engine, id))?.local_path : null) ?? await resolveBrainDir(engine, null, id);
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
    ...(input.preset === 'full' ? { deadlineAtMs: Date.now() + DEEP_ORGANIZE_PHASE_HORIZON_MS } : {}),
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
  const queueQuickVectors = async (report: import('../../core/cycle.ts').CycleReport, id: string) => {
    const sync = report.phases.find(phase => phase.phase === 'sync') as (import('../../core/cycle.ts').PhaseResult & { pagesAffected?: string[] }) | undefined;
    const slugs = [...new Set(sync?.pagesAffected ?? [])];
    if (input.dryRun || !slugs.length) return;
    try {
      const receipt = await rpc('task.quickVectors', [id, slugs, Math.min(1_800_000, (input.windowSeconds ?? 1800) * 1000)]) as { taskId?: string; pages: number; paused?: boolean };
      Object.assign(report, { quickVector: { ...receipt, sourceId: id } });
      if(quickPlan){round.vectors=[...(round.vectors??[]).filter(item=>item.sourceId!==id),{...receipt,sourceId:id}];notifyRound();}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Object.assign(report, { quickVector: { sourceId: id, pages: 0, error: message } });
      if(quickPlan){round.vectors=[...(round.vectors??[]).filter(item=>item.sourceId!==id),{sourceId:id,pages:0,error:message}];notifyRound();}
      console.error(`本轮资料的后台向量任务未能提交：${message}`);
    }
  };
  if (input.preset === 'quick') console.log('快速维护同步变化并关联已有实体；本轮资料向量化在后台进行，新实体建档和图片识别不属于本次维护。');
  if(quickPlan){
    notifyRound();
    const startedAt=new Date();
    if(input.refreshPendingSync){
      const completed=await rpc('task.quickCompletedFiles',[]) as Array<{sourceId:string;relativePath:string;hash:string}>;
      const saved=new Set(completed.map(file=>JSON.stringify([file.sourceId,file.relativePath,file.hash])));
      for(const [sourceId,plan] of Object.entries(quickPlan.sources))for(const file of plan.entries){
        if(saved.has(JSON.stringify([sourceId,file.relativePath,file.hash])))continue;
        delete checkpoint.reports[sourceId];
        checkpoint.phases[sourceId]=[];
        abort.signal.throwIfAborted();
        const info=await stat(file.path);
        file.originalSize=info.size;file.originalMtime=info.mtimeMs;file.originalCtime=info.ctimeMs;
        let oversized=false;try{assertImportFileSize(file.relativePath,info.size);}catch{oversized=true;}
        file.hash=oversized?`oversize:${info.size}:${info.mtimeMs}`:await streamFileHash(file.path,abort.signal);
        file.scanValidated=false;
      }
      input.refreshPendingSync=false;await rpc('task.maintenanceCheckpoint',[checkpoint,true]);
    }
    const available=(await loadAllSources(engine)).filter(source=>parseSourceConfig(source.config).syncEnabled!==false);
    const ids=checkpoint.quickSync!.sourceIds??(input.allSources?available.map(source=>source.id):[sourceId??'default']);
    checkpoint.quickSync!.sourceIds=ids;
    const sources=ids.map(id=>{const source=available.find(source=>source.id===id);if(!source)throw new Error(`知识源 ${id} 已停用或不存在，不能继续本轮任务`);return source;});
    if(!sources.length)throw new Error('没有可同步的知识源');
    for(const source of sources){
      abort.signal.throwIfAborted();quickPlan.sourceId=source.id;
      await quickPlan.restore(source.id);
      if(quickPlan.current?.complete)continue;
      send({type:'progress',scope:{name:source.name,index:sources.indexOf(source),total:sources.length}});
      try{
        const report=await runQuickMaintenance(engine,{...common,sourceId:source.id,brainDir:await quickBrainDir(source.id),
          syncFileRuntime:fileRuntime,phaseWindow:['sync'],afterSync:undefined});
        const failure=report.phases.find(phase=>phase.status==='fail');
        if(failure)throw new Error(failure.error?.message??failure.summary);
        if(report.reason==='cycle_already_running')return report;
      }catch(error){if(!(error instanceof SyncFilesDeferred))throw error;}
    }
    quickPlan.preparing=false;pendingFiles=false;capacityReached=false;
    round.scan=quickPlan.scan(true);notifyRound();
    await rpc('task.maintenanceCheckpoint',[checkpoint]);
    await quickPlan.discardLog();
    const reports=new Map<string,import('../../core/cycle').CycleReport>();
    for (const source of sources) {
      if (legacyCompletedReports.has(source.id)) {
        reports.set(source.id, checkpoint.reports[source.id] as unknown as import('../../core/cycle').CycleReport);
      }
    }
    const scopeSlugs=(id:string)=>[...new Set((checkpoint.phases[id]?.find(phase=>phase.phase==='sync') as import('../../core/cycle').PhaseResult&{pagesAffected?:string[]}|undefined)?.pagesAffected??[])];
    const scopes=()=>sources.map(source=>({sourceId:source.id,slugs:scopeSlugs(source.id)}));
    const groups:Array<{id:MaintenanceStageId;phases:CyclePhase[]}>= [{id:'sync',phases:['sync']},{id:'relations',phases:['extract']},{id:'check',phases:['fence_repair','content_repair']}];
    for(const group of groups){
      const savedStage=round.stages.find(stage=>stage.id===group.id);
      if(savedStage&&['completed','skipped'].includes(savedStage.status)&&sources.every(source=>group.phases.every(phase=>checkpoint.phases[source.id]?.some(saved=>saved.phase===phase))))continue;
      const previousDone=round.stage===group.id?round.current?.completed??0:0;
      round.stage=group.id;round.current={completed:previousDone,total:group.id==='sync'?round.scan.incremental??0:scopes().reduce((sum,scope)=>sum+scope.slugs.length,0)};notifyRound();
      let completed=0;
      for(const [index,source] of sources.entries()){
        if (legacyCompletedReports.has(source.id)) continue;
        abort.signal.throwIfAborted();quickPlan.sourceId=source.id;
        send({type:'progress',scope:{name:source.name,index,total:sources.length}});
        const before=Date.now();
        const options=await phaseOptions(source.id);
        const previous=new Set((checkpoint.phases[source.id]??[]).map(phase=>phase.phase));
        const processedPages=new Set<string>();
        const report=await runQuickMaintenance(engine,{...common,sourceId:source.id,brainDir:await quickBrainDir(source.id),...options,
          phaseWindow:group.phases,
          onMaintenancePages:async slugs=>{
            for(const slug of slugs)processedPages.add(slug);
            round.current={completed:Math.max(round.current!.completed,completed+processedPages.size),total:round.current!.total,file:slugs.at(-1)};
            if(group.id==='relations')round.entities=await rpc('task.quickEntityStats',[scopes()]) as MaintenanceRoundProgress['entities'];
            notifyRound();
          },
        });
        if(report.reason==='cycle_already_running')return report;
        const extracted=report.phases.find(phase=>phase.phase==='extract');
        if(group.id==='relations'&&extracted&&!previous.has('extract'))extracted.duration_ms=Date.now()-before;
        reports.set(source.id,report);
        completed+=group.id==='sync'?(quickPlan.current?.entries.length??0):group.id==='relations'&&Array.isArray(extracted?.details.relationCompletedSlugs)?extracted.details.relationCompletedSlugs.length:scopeSlugs(source.id).length;
        round.current={completed,total:round.current!.total};
        if(group.id==='relations')round.entities=await rpc('task.quickEntityStats',[scopes()]) as MaintenanceRoundProgress['entities'];
        notifyRound();
      }
      const phases=sources.flatMap(source=>(checkpoint.phases[source.id]??[]).filter(phase=>group.phases.includes(phase.phase)));
      const number=(key:string)=>phases.reduce((sum,phase)=>sum+Number(phase.details[key]??0),0);
      const partial=phases.some(phase=>phase.status==='fail'||phaseHasPendingWork(phase)||Number(phase.details.refused??0)>0);
      const result:MaintenanceStageResult={id:group.id,status:partial?'partial':phases.every(phase=>phase.status==='skipped')?'skipped':'completed',completed,total:round.current!.total,durationMs:phases.reduce((sum,phase)=>sum+phase.duration_ms,0)};
      if(group.id==='sync'){
        const counts=await rpc('task.quickFileCounts',[]) as {completed:number;failed:number;remaining:number};
        Object.assign(result,{added:number('added'),modified:number('modified'),failed:counts.failed,completed:counts.completed});
        if(counts.failed||counts.remaining)result.status='partial';
      }
      if(group.id==='relations')Object.assign(result,{links:round.entities.links,entities:round.entities.total,
        failures:phases.flatMap(phase=>Array.isArray(phase.details.relationFailures)?phase.details.relationFailures:[]),
        ...(completed<result.total?{detail:`已完成 ${completed} 页，剩余 ${result.total-completed} 页关联未完成`}:{})});
      if(group.id==='check')result.repaired=number('merged')+number('closed')+number('removed');
      round.stages=[...round.stages.filter(stage=>stage.id!==group.id),result];notifyRound();
      await rpc('task.maintenanceCheckpoint',[checkpoint]);
    }
    for(const source of sources){
      const report=reports.get(source.id)??await runQuickMaintenance(engine,{...common,sourceId:source.id,brainDir:await quickBrainDir(source.id),...await phaseOptions(source.id),phaseWindow:[]});
      reports.set(source.id,report);
      await queueQuickVectors(report,source.id);
      checkpoint.reports[source.id]={...report};
    }
    round.stage='done';round.current=undefined;notifyRound();await rpc('task.maintenanceCheckpoint',[checkpoint]);
    const entries=[...reports].map(([sourceId,report])=>({sourceId,report}));
    const combined=combineQuickMaintenanceReports(entries,startedAt);
    const vectors=entries.flatMap(({report})=>{const receipt=(report as typeof report&{quickVector?:unknown}).quickVector;return receipt?[receipt]:[];});
    return {...combined,quickVector:vectors};
  }
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
        ...common, sourceId: source.id, brainDir: await quickBrainDir(source.id),
        ...await phaseOptions(source.id),
      });
      if (report.reason === 'cycle_already_running') return report;
      await queueQuickVectors(report, source.id);
      checkpoint.reports[source.id] = { ...report };
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
      reports.push({ sourceId: source.id, report });
      if (report.phases.some(phase => phase.status === 'fail' && isGinRepairAbortText(`${phase.error?.message ?? ''}\n${phase.summary}\n${JSON.stringify(phase.details ?? {})}`))) break;
    }
    const combined = combineQuickMaintenanceReports(reports, startedAt);
    const vectors = reports.flatMap(({ report }) => {
      const value = (report as typeof report & { quickVector?: unknown }).quickVector;
      return value ? [value] : [];
    });
    return { ...combined, quickVector: vectors };
  }
  if (stagedFull && syncPlan && deepRound) {
    const startedAt = new Date();
    const dreamKnowledge = await import('./dream-knowledge');
    const knowledgeEnabled = await dreamKnowledge.prepareDreamKnowledge(engine);
    await dreamKnowledge.prepareProductEnrichThin(engine);
    const currentPack = loadConfig()?.schema_pack ?? 'gbrain-base';
    const knowledgePack = knowledgeEnabled ? (currentPack === 'gbrain-base-v2' ? 'pmbrain-knowledge' : currentPack === 'gbrain-base' ? 'gbrain-creator' : undefined) : undefined;
    const deepPhases = deepOrganizePhaseNames() as CyclePhase[];
    const available = (await loadAllSources(engine)).filter(source => parseSourceConfig(source.config).syncEnabled !== false);
    const ids = checkpoint.quickSync!.sourceIds ?? (input.allSources ? available.map(source => source.id) : [sourceId ?? 'default']);
    checkpoint.quickSync!.sourceIds = ids;
    const sources = ids.map(id => {
      const source = available.find(item => item.id === id);
      if (!source) throw new Error(`知识源 ${id} 已停用或不存在，不能继续本轮任务`);
      return source;
    });
    if (!sources.length) throw new Error('没有可同步的知识源');
    let lastReport: CycleReport | undefined;
    const stageReady = (stage: typeof DEEP_ORGANIZE_STAGES[number]) => {
      const saved = deepRound.stages.find(item => item.id === stage.id);
      if (!saved || !['completed', 'skipped'].includes(saved.status)) return false;
      if (stage.id === 'sync' && !Object.values(syncPlan.sources).every(plan => plan.complete)) return false;
      return sources.every(source => (stage.phases as readonly string[]).every(phase => checkpoint.phases[source.id]?.some(savedPhase => savedPhase.phase === phase)));
    };
    const publish = (): CycleReport => {
      const phases = sources.flatMap(source => checkpoint.phases[source.id] ?? []);
      const totals = extractTotals(phases);
      let status = deriveStatus(phases, totals);
      if (!['failed', 'skipped'].includes(status) && deepRound.stages.some(stage => stage.status === 'partial' || stage.status === 'failed')) status = 'partial';
      return { schema_version: '1', timestamp: startedAt.toISOString(), duration_ms: Date.now() - startedAt.getTime(), status, brain_dir: lastReport?.brain_dir ?? null, phases, totals };
    };
    const noteStage = (stageId: string, event: 'start' | 'finish', result?: string, durationMs?: number) => {
      deepRound.log = [...(deepRound.log ?? []), { at: new Date().toISOString(), stage: stageId, event, ...(durationMs !== undefined ? { durationMs } : {}), ...(result ? { result } : {}) }].slice(-24);
    };
    const roundChanged = (): string[] | undefined => {
      if (!deepRound.scan.complete) return undefined;
      const syncPhases = sources.map(source => checkpoint.phases[source.id]?.find(phase => phase.phase === 'sync'));
      const fromPhases = [...new Set(syncPhases.flatMap(phase => syncPhasePages(phase) ?? []).filter(slug => slug.length > 0))];
      const recorded = syncPhases.every(phase => Array.isArray((phase as { pagesAffected?: unknown } | undefined)?.pagesAffected) || Array.isArray(phase?.details?.pages_affected));
      if (recorded) return fromPhases;
      const fromPlan = [...new Set(sources.flatMap(source => (syncPlan.sources[source.id]?.entries ?? []).map(file => resolveSlugForPath(file.relativePath))).filter(slug => slug.length > 0))];
      if (fromPlan.length > 0) return fromPlan;
      return (deepRound.scan.incremental ?? 0) === 0 ? [] : undefined;
    };
    notifyDeep();
    for (const stage of DEEP_ORGANIZE_STAGES) {
      if (stageReady(stage)) continue;
      abort.signal.throwIfAborted();
      deepRound.stage = stage.id;
      deepRound.current = { result: stage.detail, startedAt: new Date().toISOString() };
      noteStage(stage.id, 'start');
      notifyDeep();
      await rpc('task.maintenanceCheckpoint', [checkpoint]);
      pauseForDocumentOcr = stage.id !== 'check' && stage.id !== 'sync';
      try {
        const changed = stage.id === 'check' || stage.id === 'sync' ? undefined : roundChanged();
        let roundSlugs = changed;
        let skippedRound = Boolean(changed && changed.length === 0);
        if (stage.id === 'knowledge' && knowledgeEnabled) {
          roundSlugs = undefined;
          skippedRound = false;
        }
        if (stage.id === 'concepts' && knowledgeEnabled) {
          roundSlugs = undefined;
          skippedRound = false;
        }
        if (stage.id === 'index' && skippedRound) {
          skippedRound = !sources.some(source => checkpoint.phases[source.id]?.some(phase =>
            Number(phase.details.knowledge_created ?? 0) > 0 || Number(phase.details.knowledge_maintained ?? 0) > 0));
        }
        if (stage.id === 'entities' && ingestEnabled && !input.dryRun) {
          for (const source of sources) {
            const requested = await rpc('task.captureRequest', [source.id]) as string[] | undefined;
            const slugs = [...new Set([...(checkpoint.captureRequests?.[source.id] ?? []), ...(requested ?? []), ...(roundSlugs ?? [])])];
            if (slugs.length) {
              checkpoint.captureRequests = { ...checkpoint.captureRequests, [source.id]: slugs };
              skippedRound = false;
              if (roundSlugs?.length === 0) roundSlugs = slugs;
            }
          }
        }
        if (skippedRound) {
          const pendingOcr = await engine.executeRaw<{ slug: string | null }>(`SELECT DISTINCT data->'task'->'input'->'ocrOnly'->>'slug' AS slug FROM minion_jobs
            WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1
            AND status IN ('waiting','active','delayed','paused','failed','dead','cancelled')
            AND (status<>'cancelled' OR data->>'ocrOwnerCancelled'='true')`, [String(ownerJobId ?? '')]);
          const slugs = pendingOcr.map(row => row.slug).filter((slug): slug is string => !!slug);
          if (slugs.length) { skippedRound = false; roundSlugs = slugs; }
        }
        if (skippedRound) {
          for (const source of sources) {
            const saved = checkpoint.phases[source.id] ?? [];
            const extra = (stage.phases as readonly string[]).filter(phase => !saved.some(item => item.phase === phase)).map(phase => ({
              phase: phase as CyclePhase, status: 'skipped' as const, duration_ms: 0, summary: '跳过', details: { reason: 'round_unchanged', message: '本轮没有新的或变化的资料，已跳过' },
            }));
            checkpoint.phases[source.id] = [...saved, ...extra];
          }
        }
        if (!skippedRound && stage.id === 'sync') {
          syncPlan.preparing = true;
          for (const [index, source] of sources.entries()) {
            abort.signal.throwIfAborted();
            syncPlan.sourceId = source.id;
            await syncPlan.restore(source.id);
            if (syncPlan.current?.complete) continue;
            send({ type: 'progress', scope: { name: source.name, index, total: sources.length } });
            try {
              const report = await runCycle(engine, {
                ...common, sourceId: source.id, brainDir: await quickBrainDir(source.id), syncFileRuntime: fileRuntime,
                phases: ['sync'], phaseWindow: ['sync'], localPathOnly: true, deferInlineExtract: true, quickMaintenance: false, includeOffice: true,
              });
              lastReport = report;
              if (report.reason === 'cycle_already_running') return report;
              const failure = report.phases.find(phase => phase.phase === 'sync' && phase.status === 'fail');
              if (failure) throw new Error(failure.error?.message ?? failure.summary);
              const syncPhase = report.phases.find(phase => phase.phase === 'sync');
              if (syncPhase && syncPhase.status !== 'fail') {
                const saved = checkpoint.phases[source.id] ?? [];
                checkpoint.phases[source.id] = [...saved.filter(phase => phase.phase !== 'sync'), syncPhase];
              }
            } catch (error) { if (!(error instanceof SyncFilesDeferred)) throw error; }
          }
          for (const source of sources) {
            syncPlan.sourceId = source.id;
            await syncPlan.restore(source.id);
            if (syncPlan.current && !syncPlan.current.complete) await syncPlan.finish();
          }
          syncPlan.preparing = false; pendingFiles = false; capacityReached = false;
          for (const [index, source] of sources.entries()) {
            abort.signal.throwIfAborted();
            syncPlan.sourceId = source.id;
            if (!syncPlan.current?.complete) continue;
            send({ type: 'progress', scope: { name: source.name, index, total: sources.length } });
            try {
              const report = await runCycle(engine, {
                ...common, sourceId: source.id, brainDir: await quickBrainDir(source.id), syncFileRuntime: fileRuntime,
                phases: ['sync'], phaseWindow: ['sync'], localPathOnly: true, deferInlineExtract: true, quickMaintenance: false, includeOffice: true,
              });
              lastReport = report;
              if (report.reason === 'cycle_already_running') return report;
              const failure = report.phases.find(phase => phase.phase === 'sync' && phase.status === 'fail');
              if (failure) throw new Error(failure.error?.message ?? failure.summary);
              const syncPhase = report.phases.find(phase => phase.phase === 'sync');
              if (syncPhase && syncPhase.status !== 'fail') {
                const saved = checkpoint.phases[source.id] ?? [];
                checkpoint.phases[source.id] = [...saved.filter(phase => phase.phase !== 'sync'), syncPhase];
              }
            } catch (error) { if (!(error instanceof SyncFilesDeferred)) throw error; }
          }
          deepRound.scan = syncPlan.scan(true);
          notifyDeep();
          await rpc('task.maintenanceCheckpoint', [checkpoint]);
          await syncPlan.discardLog();
        }
        if (!skippedRound && stage.id === 'entities' && !ingestEnabled) {
          const summary = automaticEnabled ? '未配置可用的实体识别模型' : '实体识别已关闭';
          const reason = automaticEnabled ? 'model_unavailable' : 'disabled';
          for (const source of sources) {
            const saved = checkpoint.phases[source.id] ?? [];
            if (!saved.some(phase => phase.phase === 'capture_entities')) checkpoint.phases[source.id] = [...saved, { phase: 'capture_entities', status: 'skipped', duration_ms: 0, summary, details: { reason, pages_submitted: 0 } }];
          }
        } else if (!skippedRound && stage.id !== 'sync') {
          for (const [index, source] of sources.entries()) {
            abort.signal.throwIfAborted();
            syncPlan.sourceId = source.id;
            send({ type: 'progress', scope: { name: source.name, index, total: sources.length } });
            const options = await phaseOptions(source.id);
            deepOutput = ['relations', 'knowledge', 'concepts'].includes(stage.id) ? new DeepOutputReceipt(source.id, stage.id === 'concepts', await loadAllowedSlugPrefixes()) : undefined;
            const report = await runCycle(deepOutput?.observe(engine) ?? engine, {
              ...resolveDreamRelationOptions('full', null),
              ...common, sourceId: source.id, brainDir: await quickBrainDir(source.id), ...options,
              phases: deepPhases, phaseWindow: [...stage.phases] as CyclePhase[],
              quickMaintenance: false, quickEntitiesOnly: true, reuseDuplicateKnowledgeSources: true,
              schemaPack: knowledgePack, includePendingKnowledge: knowledgeEnabled,
              enrichThinWhenUnset: true, enrichThinTypesWhenUnset: ['person', 'company', 'project'],
              ...(stage.id === 'entities' && !options.prepareEntityCapture ? { captureEntitySlugs: options.captureEntitySlugs ?? [] } : {}),
              ...(roundSlugs !== undefined ? { changedSlugs: roundSlugs, prepareEntityCapture: undefined, ...(stage.id === 'entities' ? { captureEntitySlugs: [...new Set([...(options.captureEntitySlugs ?? []), ...roundSlugs])] } : {}) } : {}),
            });
            lastReport = report;
            deepOutput = undefined;
            if (report.reason === 'cycle_already_running') return report;
          }
        }
        if (stage.id === 'check') {
          for (const source of sources) {
            checkpoint.phases[source.id] = (checkpoint.phases[source.id] ?? []).map(phase => {
              if ((phase.phase !== 'lint' && phase.phase !== 'backlinks') || phase.status !== 'fail') return phase;
              const message = phase.error?.message;
              return { ...phase, status: 'warn', error: undefined, details: { ...phase.details, check_advisory: true, ...(message ? { check_error: message } : {}) } };
            });
          }
        }
        const snapshots = sources.flatMap(source => (checkpoint.phases[source.id] ?? []).filter(phase => (stage.phases as readonly string[]).includes(phase.phase)));
        const summary = summarizeDeepStage(stage.id, snapshots, deepRound.scan);
        if (skippedRound) { summary.result = '跳过'; summary.detail = '本轮没有新的或变化的资料，已跳过'; }
        noteStage(stage.id, 'finish', summary.result, summary.durationMs);
        deepRound.stages = [...deepRound.stages.filter(item => item.id !== stage.id), summary];
        deepRound.current = { ...deepRound.current, result: summary.result };
        notifyDeep();
        await rpc('task.maintenanceCheckpoint', [checkpoint]);
        if (stage.id !== 'check' && snapshots.some(phase => phase.status === 'fail')) return publish();
      } catch (error) {
        notifyDeep();
        await rpc('task.maintenanceCheckpoint', [checkpoint]);
        throw error;
      }
    }
    deepRound.stage = 'done';
    deepRound.current = undefined;
    notifyDeep();
    await rpc('task.maintenanceCheckpoint', [checkpoint]);
    return publish();
  }
  const brainDir = input.preset === 'quick' ? await quickBrainDir(sourceId) : await resolveBrainDir(engine, null, sourceId);
  if (input.preset === 'quick') {
    const report = await runQuickMaintenance(engine, { ...common, brainDir, ...await phaseOptions(sourceId ?? 'default') });
    if (report.reason !== 'cycle_already_running') await queueQuickVectors(report, sourceId ?? 'default');
    return report;
  }
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

async function runQuickVector(engine: BrainEngine, input: Extract<ProductTask, { type: 'embed' }>['input']): Promise<void> {
  const sourceId = input.sourceId ?? 'default';
  const slugs = [...new Set(input.slugs ?? [])];
  const live = await engine.executeRaw<{ slug: string }>(`SELECT p.slug FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL AND s.archived=false`, [sourceId, slugs]);
  const available = new Set(live.map(row => row.slug));
  const selected = slugs.filter(slug => available.has(slug));
  const windowMs = Math.max(1, Math.min(1_800_000, input.windowMs ?? 1_800_000));
  const windowAbort = new AbortController();
  const timer = setTimeout(() => windowAbort.abort(new Error('本轮向量窗口已结束')), windowMs);
  const signal = AbortSignal.any([abort.signal, windowAbort.signal]);
  const preflightSession = new EmbedPreflightSession();
  let schedule: VectorizationSchedule | undefined;
  let lastBatchAt = 0;
  let done = 0;
  let embedded = 0;
  const vectorProgress=await QuickVectorProgress.load(engine,sourceId,selected,windowMs);
  const vectorSnapshot=(file?:string,finish=false)=>{
    const value=vectorProgress.snapshot(windowAbort.signal.aborted);
    send({type:'vector-totals',value});
    send({type:'progress',background:schedule,event:{phase:'embed',event:finish?'finish':undefined,done:value.completed,total:value.total,unit:'个分块',file,
      stage:value.windowEnded?'本次运行窗口已结束，已保存结果保留':undefined}});
    return value;
  };
  try {
    const initial=vectorSnapshot();
    send({ type: 'progress', event: { phase: 'embed', event: 'start', done: initial.completed, total: initial.total, unit: '个分块' } });
    for (const slug of selected) {
      if (signal.aborted) break;
      await rpc('task.searchOptimizeForgetPage', [sourceId, slug]);
      const result = await runEmbedCore(engine, {
        slugs: [slug], sourceId, batchSize: 32, writeBatchSize: engine.kind === 'pglite' ? 1 : 4,
        getBatchSize: () => Math.min(constrained ? 4 : 32, schedule?.batchSize || 4),
        preflightSession, quiet: true, signal,
        pauseCheck: async () => {
          const delay = (schedule?.delayMs ?? 0) - (Date.now() - lastBatchAt);
          if (delay > 0) await waitForBatch(delay, undefined, { signal });
          const state = await rpc('task.quickVectorState', []) as { paused?: boolean; schedule?: VectorizationSchedule };
          schedule = state.schedule;
          return Boolean(state.paused || schedule?.mode === 'waiting' || signal.aborted);
        },
        onProgress: (processed, chunks) => {
          lastBatchAt = Date.now();
          vectorProgress.page(slug,processed);vectorSnapshot(slug);
        },
      });
      embedded += result.embedded;
      if (result.incomplete || signal.aborted) {
        if (abort.signal.aborted) throw abort.signal.reason;
        vectorSnapshot(slug);
        send({ type: 'deferred', phase: 'quick_vector' });
        return;
      }
      if (result.error || result.failedPages > 0 || result.status === 'failed') {
        const message = result.error || '本轮资料向量化未完成';
        if (vectorizationRetryDelay(message, 0) !== null) send({ type: 'deferred', phase: 'quick_vector', error: message });
        else send({ type: 'error', error: message, result: { quickVector: true, status: 'failed', failures: [{ error: message }] } });
        return;
      }
      done++;
      vectorProgress.complete(slug);vectorSnapshot(slug);
    }
    if (abort.signal.aborted) throw abort.signal.reason;
    if (windowAbort.signal.aborted) {
      vectorSnapshot();
      send({ type: 'deferred', phase: 'quick_vector' });
      return;
    }
    vectorSnapshot(undefined,true);
    send({ type: 'result', result: { quickVector: true, status: 'ok', pages: done, embedded } });
  } catch (error) {
    if (windowAbort.signal.aborted && !abort.signal.aborted) {
      vectorSnapshot();
      send({ type: 'deferred', phase: 'quick_vector' });
      return;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function execute(task:ProductTask,kind:BrainEngine['kind'],skipBudget=false){
  if(task.type!=='sync-file'||skipBudget)return executeTask(task,kind);
  const tracker=await openTaskBudget(request=>rpc('task.budget',[request]) as Promise<TaskBudgetReply>);
  return tracker?withTaskBudgetTracker(tracker,()=>executeTask(task,kind)):executeTask(task,kind);
}
async function executeTask(task: ProductTask, kind: BrainEngine['kind']) {
  const rawEngine = proxyEngine(kind);
  const engine = task.type==='sync-file'&&task.input.quickMaintenance
    ? await (await import('./quick-config-snapshot.ts')).loadQuickConfigSnapshot(rawEngine) : rawEngine;
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
    const filePhases = ['collect', 'process', 'write'];
    send({ type: 'progress', phases: filePhases });
    send({ type: 'progress', event: { phase: 'import.collect' } });
    const completedPaths: string[] = [];
    if (input.resumeCheckpointId) {
      for (const file of await readTaskCheckpoint(input.resumeCheckpointId, true)) {
        if (file.completed !== true || file.modelFingerprint !== taskModelFingerprint()) continue;
        const current = await stat(String(file.absolutePath)).catch(() => null);
        if (current?.size === file.size && typeof file.hash==='string' && await streamFileHash(String(file.absolutePath),abort.signal)===file.hash) {
          completedPaths.push(String(file.path));
        }
      }
    }
    let vectorsPending = false;
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
          const rawFileHash = await streamFileHash(path, abort.signal);
          fileSnapshot = { absolutePath: path, size: file.size, mtimeMs: file.mtimeMs, hash: rawFileHash, modelFingerprint: taskModelFingerprint() };
          try {
            await rpc('task.inputFile', [{ path, size: file.size, mtimeMs: file.mtimeMs }]);
          } catch (error) {
            if (!isOversizedImportError(error)) throw error;
            return error instanceof Error ? error.message : String(error);
          }
          return { rawFileHash };
        },
        onFile: async progress => {
          const outcome=importOutcome(progress);
          if(outcome)send({type:'import-counts',value:{processed:outcome.processed,imported:Math.max(0,outcome.processed-outcome.failed-outcome.partial-outcome.unchanged),unchanged:outcome.unchanged,failed:outcome.failed,partial:outcome.partial}});
          send({ type: 'progress', event: { phase: 'import.files', done: Number(progress.processed) } });
          importFile = undefined;
          const slug = progress.slug;
          if (vectorsRequested && progress.vectorize === true && typeof slug === 'string' && slug && !slug.includes(':')) vectorsPending = true;
          await rpc('task.checkpoint', [{ ...progress, ...fileSnapshot }]);
        },
      },
    });
    result = { ...imported, resumedFiles: completedPaths.length };
    if (vectorsPending) result.vectorsPending = true;
  } else if (task.type === 'dream') {
    result = await runWithDreamBudget(task.input,async()=>({...await runDreamTask(engine,task.input)}),request=>rpc('task.budget',[request]) as Promise<TaskBudgetReply>);
  } else if (task.type === 'sync') {
    const results = [];
    const gateway = await import('../../core/ai/gateway.ts');
    const { imageOcrSwitchOn, IMAGE_OCR_ENABLED_KEY } = await import('../../core/pmbrain-adapters/image-ocr-policy.ts');
    const imageOcr = imageOcrSwitchOn(await engine.getConfig(IMAGE_OCR_ENABLED_KEY)) && gateway.isOcrEnabled();
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
        includeImages: imageOcr, documentOcr: imageOcr,
      }));
    }
    result = { results, errors: results.filter(row => ['blocked_by_failures', 'partial'].includes(row.status)).length };
  } else if (task.type === 'assistant') {
    throw new Error('助手任务由工作台执行器处理');
  } else if (task.input.quickVector === true) {
    await runQuickVector(engine, task.input);
    return;
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
  if((task.type==='dream'&&task.input.preset!=='quick')||task.type==='sync'){
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
    void execute(message.task, message.kind, message.skipBudget === true).catch(error => {
      if(error instanceof DocumentOcrDeferred){send({type:'deferred',phase:message.task.type==='dream'?'maintenance_ocr':'document_ocr'});return;}
      if(error instanceof MaintenanceVectorizationDeferred){send({type:'deferred',phase:'maintenance_embed'});return;}
      if(error instanceof EntityCaptureWindowDeferred){send({type:'deferred',phase:'capture_entities'});return;}
      if (error instanceof SyncFilesDeferred) { send({ type: 'deferred' }); return; }
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    });
  }
});
