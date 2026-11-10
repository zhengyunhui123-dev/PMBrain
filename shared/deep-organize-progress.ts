import { dreamPhaseDetail, phaseHasPendingWork, type DreamPhaseState } from './dream-phase-state';

export const DEEP_ORGANIZE_STAGES = [
  { id: 'check', title: '检查知识库', detail: '核对页面格式与反向链接', phases: ['lint', 'backlinks'] },
  { id: 'sync', title: '同步资料', detail: '扫描资料并同步有变化的文件', phases: ['sync'] },
  { id: 'relations', title: '内容综合与关联', detail: '综合符合条件的内容，并核对资料引用与关系', phases: ['fence_repair', 'content_repair', 'synthesize', 'extract', 'extract_facts', 'resolve_symbol_edges'] },
  { id: 'knowledge', title: '提炼长期知识', detail: '从资料中提炼有出处的长期知识点', phases: ['extract_atoms'] },
  { id: 'entities', title: '识别和更新实体', detail: '识别人物、项目、公司和组织，写入新的实体页面', phases: ['capture_entities'] },
  { id: 'concepts', title: '整理模式与概念', detail: '按现有规则整理模式、概念和薄弱页面', phases: ['patterns', 'synthesize_concepts', 'recompute_emotional_weight', 'consolidate', 'edge_contradictions', 'drift', 'standing_questions', 'conversation_facts_backfill', 'enrich_thin'] },
  { id: 'review', title: '完成检查', detail: '检查孤立页面和知识结构', phases: ['orphans', 'schema-suggest', 'purge'] },
] as const;

type CurrentDeepStageId = typeof DEEP_ORGANIZE_STAGES[number]['id'];
export type DeepStageId = CurrentDeepStageId | 'index';
export type DeepPhaseSnapshot = DreamPhaseState & { duration_ms?: number };

export interface DeepRunTiming {
  elapsedMs: number;
  activeSince: number | null;
}

export function deepOrganizeElapsed(timing: DeepRunTiming, now: number): number {
  return timing.elapsedMs + (timing.activeSince === null ? 0 : Math.max(0, now - timing.activeSince));
}

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
  newKnowledge?: number;
  maintainedKnowledge?: number;
  knowledgeCreatedRefs?: string[];
  knowledgeMaintainedRefs?: string[];
  entities?: number;
  links?: number;
  checked?: number;
  costCny?: number;
}

export interface DeepStageLogEntry {
  at: string;
  stage: string;
  event: 'start' | 'finish';
  durationMs?: number;
  result?: string;
}

export interface DeepRoundProgress {
  stage: DeepStageId | 'done';
  stages: DeepStageResult[];
  scan: { scanned: number; unchanged: number; incremental?: number; total?: number; complete: boolean };
  current?: { result?: string; file?: string; startedAt?: string; elapsedMs?: number };
  log?: DeepStageLogEntry[];
}

export function deepStageClosed(round: DeepRoundProgress, id: CurrentDeepStageId): boolean {
  const index = DEEP_ORGANIZE_STAGES.findIndex(stage => stage.id === id);
  const cursor = round.stage === 'done' ? DEEP_ORGANIZE_STAGES.length : DEEP_ORGANIZE_STAGES.findIndex(stage => stage.id === (round.stage === 'index' ? 'review' : round.stage));
  return index < cursor && round.stages.some(stage => stage.id === id && stage.status !== 'failed')
    && (id !== 'sync' || round.scan.complete);
}

export function deepStageElapsed(current: NonNullable<DeepRoundProgress['current']>, now: number): number {
  return (current.elapsedMs ?? 0) + (current.startedAt ? Math.max(0, now - Date.parse(current.startedAt)) : 0);
}

export function pauseDeepStage(round: DeepRoundProgress, now: number): void {
  if (round.current?.elapsedMs == null || !round.current.startedAt) return;
  round.current.elapsedMs = deepStageElapsed(round.current, now);
  delete round.current.startedAt;
}

export function isStagedDeepOrganize(input: { preset?: string | null; dryRun?: boolean; phase?: string | null }): boolean {
  return input.preset === 'full' && input.dryRun !== true && (!input.phase || input.phase === 'all');
}

export function deepOrganizePhaseNames(): (typeof DEEP_ORGANIZE_STAGES[number]['phases'][number])[] {
  return DEEP_ORGANIZE_STAGES.flatMap(stage => [...stage.phases]);
}

export function deepStageTitle(round: DeepRoundProgress): string {
  if (round.stage === 'done') return round.stages.some(stage => stage.status === 'failed' || stage.status === 'partial') ? '深度整理部分完成' : '深度整理完成';
  return DEEP_ORGANIZE_STAGES.find(stage => stage.id === (round.stage === 'index' ? 'review' : round.stage))?.title ?? '深度整理';
}

export function deepOrganizeRecordedStages(round: DeepRoundProgress): number {
  return DEEP_ORGANIZE_STAGES.filter(stage => round.stages.some(saved => saved.id === stage.id)).length;
}

export function deepOrganizePercent(round: DeepRoundProgress): number {
  const done = deepOrganizeRecordedStages(round);
  if (round.stage === 'done') return round.stages.some(stage => stage.status === 'failed' || stage.status === 'partial') ? 99 : 100;
  return Math.min(99, Math.round(done / DEEP_ORGANIZE_STAGES.length * 100));
}

export function deepOrganizeTotals(round: DeepRoundProgress) {
  const sum = (key: 'imported' | 'knowledge' | 'entities' | 'links') => round.stages.reduce((total, stage) => total + Number(stage[key] ?? 0), 0);
  const created = new Set(round.stages.flatMap(stage => stage.knowledgeCreatedRefs ?? []));
  const maintained = new Set(round.stages.flatMap(stage => stage.knowledgeMaintainedRefs ?? []).filter(ref => !created.has(ref)));
  const newKnowledge = created.size + round.stages.filter(stage => !stage.knowledgeCreatedRefs).reduce((sum, stage) => sum + (stage.newKnowledge ?? 0), 0);
  const maintainedKnowledge = maintained.size + round.stages.filter(stage => !stage.knowledgeMaintainedRefs).reduce((sum, stage) => sum + (stage.maintainedKnowledge ?? 0), 0);
  const unclassifiedKnowledge = round.stages.filter(stage => stage.newKnowledge == null).reduce((sum, stage) => sum + (stage.knowledge ?? 0), 0);
  return { files: sum('imported'), knowledge: newKnowledge + maintainedKnowledge + unclassifiedKnowledge, newKnowledge, maintainedKnowledge, unclassifiedKnowledge, entities: sum('entities'), links: sum('links') };
}

const count = (phases: DeepPhaseSnapshot[], key: string) => phases.reduce((sum, phase) => sum + Number(phase.details?.[key] ?? 0), 0);

export function summarizeDeepStage(id: CurrentDeepStageId, phases: DeepPhaseSnapshot[], scan?: DeepRoundProgress['scan']): DeepStageResult {
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
  const tracked = relevant.some(phase => typeof phase.details?.knowledge_created === 'number');
  const refs = (key: string) => [...new Set(relevant.flatMap(phase => Array.isArray(phase.details?.[key]) ? phase.details[key] as string[] : []))];
  const createdRefs = refs('knowledge_created_refs');
  const maintainedRefs = refs('knowledge_maintained_refs').filter(ref => !createdRefs.includes(ref));
  const newKnowledge = createdRefs.length || count(relevant, 'knowledge_created');
  const maintainedKnowledge = maintainedRefs.length || (refs('knowledge_maintained_refs').length ? 0 : count(relevant, 'knowledge_maintained'));
  const entities = count(relevant, 'entities_written');
  const captureLinks = count(relevant, 'relations_created');
  const extractLinks = relevant.reduce((sum, phase) => sum + Math.max(Number(phase.details?.output_links_created ?? 0), Number(phase.details?.linksCreated ?? 0) + Number(phase.details?.edges_resolved ?? 0)), 0);
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
  if (tracked && ['relations', 'knowledge', 'concepts'].includes(id)) result = `新建 ${newKnowledge} 个知识成果，维护 ${maintainedKnowledge} 个${extractLinks ? `，新增 ${extractLinks} 条关联` : ''}`;
  if (id === 'review' && !explained) result = `孤立页面 ${count(relevant, 'total_orphans')}`;
  const roundWork = relevant.some(phase => typeof phase.details?.round_fresh_processed === 'number');
  const roundTimeReached = relevant.some(phase => phase.details?.round_time_reached === true);
  const synthesisWork = relevant.some(phase => typeof phase.details?.round_synthesis_fresh === 'number');
  const unit = id === 'concepts' ? '个概念' : '份资料';
  const roundDetail = [
    ...(roundWork ? [`本轮新增或变更处理 ${count(relevant, 'round_fresh_processed')} ${unit}，历史积压处理 ${count(relevant, 'round_older_processed')} ${unit}，待处理候选 ${count(relevant, 'round_remaining')}`] : []),
    ...(id === 'entities' && count(relevant, 'chunks_failed') > 0
      ? [`${count(relevant, 'pages_failed')} 份资料有未通过的分块，共 ${count(relevant, 'chunks_failed')} 个分块失败`] : []),
    ...(synthesisWork || count(relevant, 'round_synthesis_remaining') ? [`综合本轮对话 ${count(relevant, 'round_synthesis_fresh')} 份，历史对话 ${count(relevant, 'round_synthesis_older')} 份，待综合 ${count(relevant, 'round_synthesis_remaining')} 份`] : []),
    ...(roundTimeReached ? ['本阶段时间额度已用完，剩余留到下一轮'] : []),
  ];
  const detail = id === 'sync' && scan?.complete ? `扫描 ${scan.total ?? scan.scanned}，未变化 ${scan.unchanged}，失败 ${failedFiles}` : explained && tracked ? `${spec.detail}；${explained}` : spec.detail;
  return {
    id, status, durationMs, result,
    detail: [detail, ...roundDetail].join('。'),
    ...(id === 'sync' ? { imported: added + modified, added, modified, failed: failedFiles } : {}),
    ...(id === 'knowledge' ? { knowledge } : {}),
    ...(tracked ? { newKnowledge, maintainedKnowledge,
      ...(relevant.some(phase => Array.isArray(phase.details?.knowledge_created_refs)) ? { knowledgeCreatedRefs: createdRefs, knowledgeMaintainedRefs: maintainedRefs } : {}) } : {}),
    ...(id === 'entities' ? { entities, links: captureLinks } : {}),
    ...(['relations', 'knowledge', 'concepts'].includes(id) ? { links: extractLinks } : {}),
    ...(id === 'check' ? { checked, links: count(relevant, 'added') } : {}),
    ...(cost > 0 ? { costCny: cost } : {}),
  };
}

export function applyDeepSyncFileCounts(summary: DeepStageResult, scan: DeepRoundProgress['scan'], files?: { total: number; completed: number; failed: number; remaining: number }): DeepStageResult {
  if (!files?.total || summary.id !== 'sync') return summary;
  const unlisted = Math.max(0, (summary.failed ?? 0) - files.failed);
  const failed = files.failed + unlisted;
  const status = summary.status === 'failed' ? 'failed' : failed || files.remaining ? 'partial' : summary.status;
  return { ...summary, status, failed, detail: `扫描 ${scan.total ?? scan.scanned}，未变化 ${scan.unchanged}，文件队列成功 ${files.completed}，失败 ${files.failed}${files.remaining ? `，待处理 ${files.remaining}` : ''}${unlisted ? `，同步阶段另有 ${unlisted} 份失败未进入文件队列` : ''}` };
}
