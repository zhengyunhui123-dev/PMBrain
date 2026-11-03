export type MaintenanceStageId = 'sync' | 'relations' | 'check';
export interface MaintenanceRelationFailure {
  sourceId: string;
  slug?: string;
  path?: string;
  step: string;
  error: string;
}
export interface MaintenanceStageResult {
  id: MaintenanceStageId;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
  completed: number;
  total: number;
  durationMs: number;
  added?: number;
  modified?: number;
  failed?: number;
  repaired?: number;
  links?: number;
  entities?: number;
  detail?: string;
  failures?: MaintenanceRelationFailure[];
}
export interface MaintenanceRoundProgress {
  vectors?: Array<{taskId?:string;sourceId:string;pages:number;error?:string}>;
  scan: { scanned: number; unchanged: number; total?: number; incremental?: number; complete: boolean };
  stage: MaintenanceStageId | 'done';
  current?: { completed: number; total: number; file?: string };
  stages: MaintenanceStageResult[];
  entities: { total: number; person: number; project: number; organization: number; company: number; links: number };
}
export interface TaskDatabaseStatistics {
  supported: boolean;
  requests: number;
  writes: number;
  waitedMs: number;
  stages: Record<string, { requests: number; writes: number; waitedMs: number }>;
}
type Files = { total: number; completed: number; failed: number; remaining: number };
export const MAINTENANCE_STAGE_LABELS = { sync: '扫描与导入', relations: '关联已有实体', check: '检查页面' };
export function maintenanceStageSummary(round: MaintenanceRoundProgress, files?: Files) {
  const total = round.scan.incremental ?? null;
  const completed = round.stage === 'sync' ? files?.completed ?? 0 : round.stage === 'done' ? total ?? 0 : round.current?.completed ?? 0;
  const stageTotal = round.stage === 'sync' || round.stage === 'done' ? total : round.current?.total ?? total;
  return { completed, total: stageTotal, failed: round.stage === 'sync' ? files?.failed ?? 0 : 0,
    remaining: stageTotal == null ? null : Math.max(0, stageTotal - completed - (round.stage === 'sync' ? files?.failed ?? 0 : 0)) };
}
export function maintenancePhaseDatabase(round: { scan: { complete: boolean }; stage: string } | undefined, stats?: TaskDatabaseStatistics) {
  if (!stats?.supported) return undefined;
  if (!round) return { waitedMs: stats.waitedMs, writes: stats.writes, label: '本任务请求累计等待' as const };
  const phase = stats.stages[round.scan.complete ? round.stage : 'scan'];
  return { waitedMs: phase?.waitedMs ?? 0, writes: phase?.writes ?? 0, label: '本阶段等待' as const };
}
export function maintenancePercent(round: MaintenanceRoundProgress, files?: Files): number | null {
  if (!round.scan.complete) return null;
  if (round.stage === 'done') return round.stages.some(stage => ['partial', 'failed'].includes(stage.status)) ? 99 : 100;
  const stage = ['sync', 'relations', 'check'].indexOf(round.stage), summary = maintenanceStageSummary(round, files);
  const portion = summary.total === 0 ? 1 : summary.total == null ? 0 : Math.min(1, summary.completed / summary.total);
  return Math.min(99, Math.round((stage + portion) / 3 * 1000) / 10);
}
