import { importOutcome } from './import-outcome';

export interface TaskViewRun {
  kind: string;
  status: string;
  error?: string | null;
  searchOptimize?: boolean;
  result?: unknown;
  product?: {
    stage?: string;
    background?: { mode?: string } | null;
  } | null;
}

export type TaskViewState =
  | 'stopping'
  | 'paused'
  | 'retry_wait'
  | 'idle_wait'
  | 'skipped'
  | 'ai_skipped'
  | 'partial'
  | 'round_done'
  | 'imported'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TASK_VIEW_LABEL: Record<TaskViewState, string> = {
  stopping: '正在停止',
  paused: '已暂停',
  retry_wait: '等待重试',
  idle_wait: '等待空闲',
  skipped: '未执行',
  ai_skipped: 'AI 提炼未执行',
  partial: '部分完成',
  round_done: '本轮已完成',
  imported: '导入成功',
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};

const JOB_STATE: Record<string, TaskViewState> = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  paused: 'paused',
};

function resultStatus(result: unknown): string | undefined {
  return result && typeof result === 'object' ? (result as { status?: string }).status : undefined;
}

export function taskWasSkipped(run: TaskViewRun): boolean {
  return resultStatus(run.result) === 'skipped' || run.product?.stage === '任务未执行';
}

export function taskIsPartial(run: TaskViewRun): boolean {
  return resultStatus(run.result) === 'partial'
    || run.product?.stage?.startsWith('部分完成') === true
    || (run.kind === 'import_path' && !['running', 'queued', 'cancelled'].includes(run.status) && importOutcome(run.result)?.outcome === 'partial');
}

export function taskViewState(run: TaskViewRun): TaskViewState | null {
  if (run.status === 'running' && run.error === '正在停止任务…') return 'stopping';
  if (run.searchOptimize && run.status === 'paused') return 'paused';
  if (run.searchOptimize && run.status === 'queued' && run.product?.background?.mode === 'waiting') {
    return run.product.stage?.includes('自动重试') ? 'retry_wait' : 'idle_wait';
  }
  if (run.kind === 'embed_stale' && run.status === 'cancelled') return 'paused';
  const live = run.status === 'queued' || run.status === 'running';
  if (!live && taskWasSkipped(run)) return 'skipped';
  if (!live && run.product?.stage?.includes('AI 提炼未执行')) return 'ai_skipped';
  if (run.kind !== 'import_path' && run.status === 'completed' && taskIsPartial(run)) return 'partial';
  if (run.kind.startsWith('dream_') && run.status === 'completed' && !taskWasSkipped(run)) return 'round_done';
  if (run.kind === 'import_path' && taskIsPartial(run)) return 'partial';
  if (run.kind === 'import_path' && run.status === 'completed') return 'imported';
  return JOB_STATE[run.status] ?? null;
}

export function taskStatusLabel(run: TaskViewRun): string | undefined {
  const state = taskViewState(run);
  return state ? TASK_VIEW_LABEL[state] : undefined;
}
