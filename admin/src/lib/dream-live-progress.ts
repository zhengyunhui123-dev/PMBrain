import type { ConsoleRun } from '../../../shared/contracts/common.ts';

export type DreamPhaseState = 'pending' | 'active' | 'completed' | 'skipped' | 'warning' | 'error';

export interface DreamPhaseProgressStep {
  phase: string;
  state: DreamPhaseState;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  note: string | null;
  done: number | null;
  total: number | null;
}

export interface DreamLiveProgress {
  steps: DreamPhaseProgressStep[];
  total: number;
  completed: number;
  remaining: number;
  activePhase: string | null;
  elapsedMs: number;
  activeElapsedMs: number | null;
  lastActivityAt: string | null;
}

const MEETING_PHASES = [
  'synthesize', 'extract', 'extract_facts', 'extract_atoms', 'resolve_symbol_edges', 'embed',
];

const QUICK_PHASES = [
  'lint', 'backlinks', 'sync', 'extract', 'extract_facts', 'resolve_symbol_edges', 'embed', 'orphans',
];

const PHASE_PURPOSE: Record<string, string> = {
  lint: '检查标题、类型和内容规范',
  backlinks: '发现并补全双向引用',
  sync: '读取最近新增和变化的资料',
  synthesize: 'AI 将记录整理为长期知识',
  extract: '识别链接、人物、地点和时间线',
  extract_facts: '提炼可以长期保留的事实',
  extract_atoms: '把复杂内容拆成原子知识点',
  resolve_symbol_edges: '建立知识点之间的确定性关系',
  patterns: '发现跨文档反复出现的模式',
  synthesize_concepts: '把相关知识归纳为高级概念',
  recompute_emotional_weight: '更新内容的情感重要性',
  consolidate: '合并相似或重复的事实',
  propose_takes: '生成值得进一步确认的观点',
  grade_takes: '评估候选观点的质量',
  calibration_profile: '更新 AI 对用户判断习惯的理解',
  drift: '检查知识与判断是否发生漂移',
  conversation_facts_backfill: '把会话中确认的事实补回知识库',
  enrich_thin: '补充信息不足的知识页面',
  embed: '更新向量索引和 AI 搜索能力',
  orphans: '发现缺少关联的孤立知识',
  'schema-suggest': '检查知识结构是否需要优化',
  purge: '清理已标记且可安全移除的数据',
};

function commandValue(command: string[], flag: string): string | null {
  const index = command.indexOf(flag);
  return index >= 0 ? command[index + 1] ?? null : null;
}

export function plannedDreamPhases(command: string[], catalog: string[]): string[] {
  const singlePhase = commandValue(command, '--phase');
  if (singlePhase) return catalog.includes(singlePhase) ? [singlePhase] : [];
  const preset = commandValue(command, '--preset');
  if (preset === 'meeting') return MEETING_PHASES.filter(phase => catalog.includes(phase));
  if (preset === 'quick') return QUICK_PHASES.filter(phase => catalog.includes(phase));
  return [...catalog];
}

function rootCyclePhase(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('cycle.')) return null;
  return value.slice('cycle.'.length).split('.')[0] || null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function terminalState(value: unknown): DreamPhaseState | null {
  if (value === 'ok' || value === 'completed' || value === 'done') return 'completed';
  if (value === 'skipped') return 'skipped';
  if (value === 'warn' || value === 'warning' || value === 'partial') return 'warning';
  if (value === 'fail' || value === 'failed' || value === 'error') return 'error';
  return null;
}

function reportPhases(run: ConsoleRun): Array<Record<string, unknown>> {
  const result = run.result;
  if (!result || typeof result !== 'object') return [];
  const phases = (result as { phases?: unknown }).phases;
  return Array.isArray(phases) ? phases.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
}

function maxTimestamp(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current || Date.parse(candidate) > Date.parse(current)) return candidate;
  return current;
}

export function buildDreamLiveProgress(
  run: ConsoleRun,
  catalog: string[],
  now = Date.now(),
): DreamLiveProgress {
  const phases = plannedDreamPhases(run.command, catalog);
  const steps = phases.map<DreamPhaseProgressStep>(phase => ({
    phase,
    state: 'pending',
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    note: null,
    done: null,
    total: null,
  }));
  const byPhase = new Map(steps.map(step => [step.phase, step]));
  let activePhase: string | null = null;
  let lastActivityAt: string | null = null;

  for (const line of run.stderr.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let event: Record<string, unknown> | null = null;
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object') event = parsed as Record<string, unknown>;
      } catch {
        // Older runs may mix human diagnostics with JSON progress.
      }
    }
    if (event) {
      const rawPhase = typeof event.phase === 'string' ? event.phase : '';
      const phase = rootCyclePhase(rawPhase);
      const step = phase ? byPhase.get(phase) : undefined;
      if (!step) continue;
      const timestamp = validIso(event.ts);
      lastActivityAt = maxTimestamp(lastActivityAt, timestamp);
      const eventName = String(event.event ?? '');
      const isRootEvent = rawPhase === `cycle.${phase}`;
      if (typeof event.done === 'number' && Number.isFinite(event.done)) step.done = event.done;
      if (typeof event.total === 'number' && Number.isFinite(event.total)) step.total = event.total;
      if (eventName === 'start' && isRootEvent) {
        step.state = 'active';
        step.startedAt ??= timestamp;
        activePhase = phase;
      } else if (eventName === 'finish' && isRootEvent) {
        step.state = terminalState(event.status) ?? 'completed';
        step.durationMs = typeof event.elapsed_ms === 'number' ? event.elapsed_ms : step.durationMs;
        step.finishedAt = timestamp;
        if (activePhase === phase) activePhase = null;
      } else if (eventName === 'abort' && isRootEvent) {
        step.state = 'error';
        step.durationMs = typeof event.elapsed_ms === 'number' ? event.elapsed_ms : step.durationMs;
        step.finishedAt = timestamp;
        if (activePhase === phase) activePhase = null;
      }
      if (typeof event.note === 'string' && event.note.trim()) step.note = event.note.trim();
      continue;
    }

    const human = text.match(/^\[cycle\.([a-z0-9_-]+)]\s+(start|done)\b/i);
    if (!human) continue;
    const step = byPhase.get(human[1]!);
    if (!step) continue;
    if (human[2]!.toLowerCase() === 'start') {
      step.state = 'active';
      activePhase = step.phase;
    } else {
      step.state = 'completed';
      if (activePhase === step.phase) activePhase = null;
    }
  }

  for (const phaseResult of reportPhases(run)) {
    const phase = typeof phaseResult.phase === 'string' ? phaseResult.phase : '';
    const step = byPhase.get(phase);
    if (!step) continue;
    step.state = terminalState(phaseResult.status) ?? step.state;
    const duration = phaseResult.durationMs ?? phaseResult.duration_ms;
    if (typeof duration === 'number' && Number.isFinite(duration)) step.durationMs = duration;
  }

  const finishedCount = steps.filter(step => step.state !== 'pending' && step.state !== 'active').length;
  const startedAt = Date.parse(run.startedAt);
  const elapsedMs = typeof run.durationMs === 'number'
    ? Math.max(0, run.durationMs)
    : Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const activeStep = activePhase ? byPhase.get(activePhase) : undefined;
  const activeStartedAt = activeStep?.startedAt ? Date.parse(activeStep.startedAt) : Number.NaN;
  const activeElapsedMs = Number.isFinite(activeStartedAt) ? Math.max(0, now - activeStartedAt) : null;

  return {
    steps,
    total: steps.length,
    completed: finishedCount,
    remaining: Math.max(0, steps.length - finishedCount),
    activePhase,
    elapsedMs,
    activeElapsedMs,
    lastActivityAt,
  };
}

export function dreamPhasePurpose(phase: string): string {
  return PHASE_PURPOSE[phase] ?? '执行这一阶段的知识整理工作';
}

export function dreamPhaseOptionText(
  phase: string,
  label: string,
  requiresGenerativeModel: boolean,
  generativeEnabled: boolean,
): string {
  if (requiresGenerativeModel && !generativeEnabled) return `${label} · 需要普通模型`;
  return `${label} · ${dreamPhasePurpose(phase)}`;
}
