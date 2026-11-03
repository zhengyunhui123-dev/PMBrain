import { dreamPhaseDetail, phaseHasPendingWork, type DreamPhaseState } from './dream-phase-state';

export const DEEP_ORGANIZE_STAGES = [
  { id: 'check', title: '检查知识库', detail: '核对页面格式与反向链接', phases: ['lint', 'backlinks'] },
  { id: 'sync', title: '同步资料', detail: '扫描资料并同步有变化的文件', phases: ['sync'] },
  { id: 'relations', title: '理解内容与关联', detail: '调用模型理解内容，并核对事实栏、页面引用和关联', phases: ['fence_repair', 'content_repair', 'synthesize', 'extract', 'extract_facts', 'resolve_symbol_edges'] },
  { id: 'knowledge', title: '提炼长期知识', detail: '从资料中提炼有出处的长期知识点', phases: ['extract_atoms'] },
  { id: 'entities', title: '识别和更新实体', detail: '识别人物、项目、公司和组织，写入新的实体页面', phases: ['capture_entities'] },
  { id: 'concepts', title: '整理模式与概念', detail: '按现有规则整理模式、概念和薄弱页面', phases: ['patterns', 'synthesize_concepts', 'recompute_emotional_weight', 'consolidate', 'edge_contradictions', 'drift', 'standing_questions', 'conversation_facts_backfill', 'enrich_thin'] },
  { id: 'index', title: '更新搜索索引', detail: '更新本次待处理内容的搜索向量', phases: ['embed'] },
  { id: 'review', title: '完成检查', detail: '检查孤立页面和知识结构', phases: ['orphans', 'schema-suggest', 'purge'] },
] as const;

export type DeepStageId = typeof DEEP_ORGANIZE_STAGES[number]['id'];
export type DeepPhaseSnapshot = DreamPhaseState & { duration_ms?: number };

export interface DeepStageResult {
  id: DeepStageId;
  status: 'completed' | 'partial' | 'skipped' | 'failed';
  durationMs: number;
  result: string;
  detail: string;
  imported?: number;
  added?: number;
  modified?: number;
  failed?: number;
  knowledge?: number;
  entities?: number;
  links?: number;
  checked?: number;
  costCny?: number;
}

export interface DeepRoundProgress {
  stage: DeepStageId | 'done';
  stages: DeepStageResult[];
  scan: { scanned: number; unchanged: number; incremental?: number; total?: number; complete: boolean };
  current?: { result?: string; file?: string; startedAt?: string };
}

export function isStagedDeepOrganize(input: { preset?: string | null; dryRun?: boolean; phase?: string | null }): boolean {
  return input.preset === 'full' && input.dryRun !== true && (!input.phase || input.phase === 'all');
}

export function deepOrganizePhaseNames(): string[] {
  return DEEP_ORGANIZE_STAGES.flatMap(stage => [...stage.phases]);
}

export function deepStageTitle(round: DeepRoundProgress): string {
  if (round.stage === 'done') return round.stages.some(stage => stage.status === 'failed' || stage.status === 'partial') ? '深度整理部分完成' : '深度整理完成';
  return DEEP_ORGANIZE_STAGES.find(stage => stage.id === round.stage)?.title ?? '深度整理';
}

export function deepOrganizePercent(round: DeepRoundProgress): number {
  const done = round.stages.filter(stage => stage.status === 'completed' || stage.status === 'skipped').length;
  if (round.stage === 'done') return round.stages.some(stage => stage.status === 'failed' || stage.status === 'partial') ? 99 : 100;
  return Math.min(99, Math.round(done / DEEP_ORGANIZE_STAGES.length * 100));
}

export function deepOrganizeTotals(round: DeepRoundProgress) {
  const sum = (key: 'imported' | 'knowledge' | 'entities' | 'links') => round.stages.reduce((total, stage) => total + Number(stage[key] ?? 0), 0);
  return { files: sum('imported'), knowledge: sum('knowledge'), entities: sum('entities'), links: sum('links') };
}

const count = (phases: DeepPhaseSnapshot[], key: string) => phases.reduce((sum, phase) => sum + Number(phase.details?.[key] ?? 0), 0);

export function summarizeDeepStage(id: DeepStageId, phases: DeepPhaseSnapshot[], scan?: DeepRoundProgress['scan']): DeepStageResult {
  const spec = DEEP_ORGANIZE_STAGES.find(stage => stage.id === id)!;
  const names = new Set<string>(spec.phases);
  const relevant = phases.filter(phase => names.has(String(phase.phase)));
  const failed = relevant.some(phase => phase.status === 'fail');
  const pending = relevant.some(phase => phase.status === 'warn' || phaseHasPendingWork(phase));
  const skipped = relevant.length === 0 || relevant.every(phase => phase.status === 'skipped');
  const status: DeepStageResult['status'] = failed ? 'failed' : pending ? 'partial' : skipped ? 'skipped' : 'completed';
  const durationMs = relevant.reduce((sum, phase) => sum + Number(phase.duration_ms ?? 0), 0);
  const cost = relevant.reduce((sum, phase) => sum + Number(phase.details?.cost_cny ?? 0), 0);
  const explained = relevant.map(dreamPhaseDetail).find((text): text is string => !!text);
  const advisory = relevant.map(phase => phase.details?.check_error).find((text): text is string => typeof text === 'string');
  const added = count(relevant, 'added');
  const modified = count(relevant, 'modified');
  const failedFiles = count(relevant, 'failedFiles');
  const knowledge = count(relevant, 'atoms_extracted');
  const entities = count(relevant, 'entities_written');
  const captureLinks = count(relevant, 'relations_created');
  const extractLinks = count(relevant, 'linksCreated');
  const checked = count(relevant, 'pages_scanned');
  let result = explained ?? spec.detail;
  if (id === 'check') result = advisory ? `检查未完成：${advisory}` : `检查 ${checked} 个页面，修正 ${count(relevant, 'fixed')} 处，发现 ${count(relevant, 'gaps')} 条反向链接缺口`;
  if (id === 'sync') result = `同步 ${added + modified}，新增 ${added}，更新 ${modified}`;
  if (id === 'relations' && !explained) {
    const synthesized = relevant.find(phase => phase.phase === 'synthesize');
    result = synthesized && synthesized.status !== 'skipped' ? `已调用模型理解内容，保存 ${extractLinks} 条关联` : extractLinks ? `保存 ${extractLinks} 条关联` : '本阶段未调用模型';
  }
  if (id === 'knowledge' && !explained) result = `提炼 ${knowledge} 条知识点，处理 ${count(relevant, 'pages_processed')} 份资料`;
  if (id === 'entities' && !explained) {
    const summary = relevant.map(phase => phase.summary).find((text): text is string => !!text);
    result = count(relevant, 'pages_submitted') === 0 && entities === 0 ? summary || '没有新增待识别资料' : `写入 ${entities} 个实体，新增 ${captureLinks} 条关联`;
  }
  if (id === 'concepts' && !explained) result = skipped ? (relevant.map(phase => phase.summary).find(Boolean) || spec.detail) : spec.detail;
  if (id === 'index' && !explained) result = `已保存 ${count(relevant, 'embedded')} 个向量，剩余 ${count(relevant, 'remainingChunks')} 个分块`;
  if (id === 'review' && !explained) result = `孤立页面 ${count(relevant, 'total_orphans')}`;
  return {
    id, status, durationMs, result,
    detail: id === 'sync' && scan?.complete ? `扫描 ${scan.total ?? scan.scanned}，未变化 ${scan.unchanged}，失败 ${failedFiles}` : spec.detail,
    ...(id === 'sync' ? { imported: added + modified, added, modified, failed: failedFiles } : {}),
    ...(id === 'knowledge' ? { knowledge } : {}),
    ...(id === 'entities' ? { entities, links: captureLinks } : {}),
    ...(id === 'relations' ? { links: extractLinks } : {}),
    ...(id === 'check' ? { checked } : {}),
    ...(cost > 0 ? { costCny: cost } : {}),
  };
}
