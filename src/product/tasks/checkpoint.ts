import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import { createHash } from 'node:crypto';
import type { SyncFileOptions } from '../../core/sync-file-runtime.ts';
import { SYNC_FILE_FORMAT_VERSION } from '../../core/sync-file-runtime.ts';
import { phaseHasPendingWork } from '../../../shared/dream-phase-state.ts';
import { DEEP_ORGANIZE_STAGES, pauseDeepStage } from '../../../shared/deep-organize-progress.ts';
import type { MaintenanceCheckpoint, ProductTask } from './types.ts';
import { isOfficeFilePath } from '../../core/sync.ts';
import { isImageFilePath } from '../../core/import-file.ts';

export function setMaintenanceCheckpoint(task: ProductTask, checkpoint: MaintenanceCheckpoint): void {
  if (task.type === 'dream') task.input.checkpoint = checkpoint;
  else if (task.type === 'import' || task.type === 'memory') task.input.knowledgeCheckpoint = checkpoint;
  else throw new Error('该任务不能保存知识整理检查点');
}

export function retireAutomaticCapture(checkpoint: MaintenanceCheckpoint): void {
  const sources = new Set([...Object.keys(checkpoint.phases), ...Object.keys(checkpoint.reports), ...Object.keys(checkpoint.captureWindows ?? {})]);
  for (const source of sources) {
    const phases = checkpoint.phases[source] ?? [];
    const capture = phases.filter(phase => phase.phase === 'capture_entities');
    const window = checkpoint.captureWindows?.[source];
    const report = checkpoint.reports[source];
    const reportHasCapture = Array.isArray(report?.phases) && report.phases.some(phase => phase?.phase === 'capture_entities');
    if (!capture.length && !window && !reportHasCapture) continue;
    checkpoint.retiredCapture ??= {};
    checkpoint.retiredCapture[source] = { phases: [...capture, ...(window ? [window] : [])], ...(report ? { report } : {}) };
    checkpoint.phases[source] = phases.filter(phase => phase.phase !== 'capture_entities');
    if (reportHasCapture) delete checkpoint.reports[source];
    if (checkpoint.captureWindows) delete checkpoint.captureWindows[source];
  }
}

export function resumeMaintenanceCheckpoint(checkpoint:MaintenanceCheckpoint,retryCompleted=false,preserveWarnings=false):void {
  for(const [source,report] of Object.entries(checkpoint.reports)) {
    if((Array.isArray(report.phases)&&report.phases.some(phase=>phase.status==='fail'||phaseHasPendingWork(phase)))
      || retryCompleted && !['ok','clean'].includes(String(report.status)))delete checkpoint.reports[source];
  }
  for(const [source,phases] of Object.entries(checkpoint.phases)) {
    if(checkpoint.reports[source])continue;
    const unfinished=phases.findIndex(phase=>phase.status==='fail' || (phase.status==='warn' && (
      phaseHasPendingWork(phase)
      || (retryCompleted && !preserveWarnings))));
    if(unfinished>=0)checkpoint.phases[source]=phases.slice(0,unfinished);
  }
}

export function resumeDeepOrganizeCheckpoint(checkpoint: MaintenanceCheckpoint, stoppedAt: number): void {
  const round = checkpoint.deepProgress;
  if (!round) {
    resumeMaintenanceCheckpoint(checkpoint, false, true);
    return;
  }
  pauseDeepStage(round, stoppedAt);
  if (round.stage === 'done') {
    const pendingIndex = DEEP_ORGANIZE_STAGES.findIndex(stage => {
      const names = new Set<string>(stage.phases);
      return Object.values(checkpoint.phases).some(phases => phases.some(phase => names.has(phase.phase)
        && (phase.status === 'fail' || (phase.status === 'warn' && phaseHasPendingWork(phase)))));
    });
    if (pendingIndex >= 0) {
      const reopenNames = new Set<string>(DEEP_ORGANIZE_STAGES.slice(pendingIndex).flatMap(stage => [...stage.phases]));
      round.stage = DEEP_ORGANIZE_STAGES[pendingIndex].id;
      round.stages = round.stages.filter(saved => {
        const index = DEEP_ORGANIZE_STAGES.findIndex(stage => stage.id === saved.id);
        return index >= 0 && index < pendingIndex;
      });
      delete round.current;
      for (const [source, phases] of Object.entries(checkpoint.phases)) {
        checkpoint.phases[source] = phases.filter(phase => !reopenNames.has(phase.phase));
        delete checkpoint.reports[source];
      }
      if (reopenNames.has('extract_atoms')) delete checkpoint.deepAtomPlans;
      return;
    }
  }
  const current = DEEP_ORGANIZE_STAGES.find(stage => stage.id === round.stage);
  if (!current) return;
  const phaseNames = new Set<string>(current.phases);
  for (const [source, phases] of Object.entries(checkpoint.phases)) {
    const unfinished = phases.findIndex(phase => phaseNames.has(phase.phase)
      && (phase.status === 'fail' || (phase.status === 'warn' && phaseHasPendingWork(phase))));
    if (unfinished < 0) continue;
    checkpoint.phases[source] = phases.filter((phase, index) => index < unfinished || !phaseNames.has(phase.phase));
    delete checkpoint.reports[source];
  }
}

export function syncFileContentFingerprint(options:SyncFileOptions):string {
  return createHash('sha256').update(JSON.stringify([SYNC_FILE_FORMAT_VERSION,options.sourceId??'default',
    options.structured!==false,options.session===true,options.includeOffice===true,options.includeImages===true,
    options.documentOcr===true,options.activePack?.page_types.map(type=>[type.name,type.path_prefixes])])).digest('hex');
}

export function syncFileCompatibleFingerprints(options: SyncFileOptions, path: string): string[] {
  const image = isImageFilePath(path);
  const documentOcrVariants = options.documentOcr && (isOfficeFilePath(path) || image) ? [true] : [true, false];
  const includeImagesVariants = image ? [options.includeImages === true] : [true, false];
  return [...new Set(documentOcrVariants.flatMap(documentOcr => includeImagesVariants.map(includeImages => syncFileContentFingerprint({ ...options, documentOcr, includeImages }))))];
}

export function taskModelFingerprint(): string {
  const config = loadConfig();
  const fields = Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => /model|embedding|ocr|rerank|expansion|provider|api_key/.test(key) || key === 'chat_fallback_chain'));
  return createHash('sha256').update(JSON.stringify([fields, (config?.desktop as Record<string, unknown> | undefined)?.model_services])).digest('hex');
}

function taskBrainKey(): string {
  const config = loadConfig();
  return createHash('sha256').update(JSON.stringify([config?.engine, config?.database_path, config?.database_url])).digest('hex').slice(0, 24);
}

export function taskArtifactPath(id: number, suffix = 'jsonl'): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid task checkpoint');
  if (!['jsonl','files.jsonl','stop.json'].includes(suffix)) throw new Error('Invalid task artifact');
  return join(gbrainPath('task-artifacts'), `${taskBrainKey()}-job-${id}.${suffix}`);
}

export function quickScanLogPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid task checkpoint');
  return join(gbrainPath('task-artifacts'), `${taskBrainKey()}-job-${id}.quick-scan.jsonl`);
}

export async function appendTaskCheckpoint(id: number, file: Record<string, unknown>): Promise<void> {
  await mkdir(gbrainPath('task-artifacts'), { recursive: true });
  await appendFile(taskArtifactPath(id), `${JSON.stringify(file)}\n`, { mode: 0o600 });
}

export async function readTaskCheckpoint(id: number, repairTail = false): Promise<Array<Record<string, unknown>>> {
  const path = taskArtifactPath(id);
  const text = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  const lines = text.split('\n');
  const tail = lines.pop();
  const records = lines.filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  if (tail) {
    let last: Record<string, unknown>;
    try { last = JSON.parse(tail); }
    catch {
      if (repairTail) await truncate(path, Buffer.byteLength(text.slice(0, -tail.length)));
      return records;
    }
    if (repairTail) await appendFile(path, '\n');
    records.push(last);
  }
  return records;
}
