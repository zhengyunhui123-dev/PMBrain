import type { ConsoleRun } from '../lib/shared';
import { taskRoundSummary } from './task-presentation';

export interface OrganizeDigest {
  when: string | null;
  scope: string;
  updated: string[];
  failed: string[];
  judgment: string[];
  empty: boolean;
}

const organizing = (kind: string) => kind.startsWith('dream_') || kind === 'import_path';
const skipped = (run: ConsoleRun) => run.product?.stage === '任务未执行';

export function homeOrganizeDigest(runs: ConsoleRun[]): OrganizeDigest {
  const related = runs.filter(run => organizing(run.kind));
  const last = related
    .filter(run => run.status === 'completed' && !skipped(run) && run.completedAt)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
  if (!last) return { when: null, scope: '', updated: [], failed: [], judgment: [], empty: true };
  const summary = taskRoundSummary(last);
  const failed = [
    ...summary.remaining.filter(item => item.includes('失败')),
    ...related.filter(run => run.status === 'failed').map(run => run.product?.errorReason || run.error || '').filter(Boolean),
  ];
  const judgment = summary.remaining.filter(item => !item.includes('失败'));
  const stage = last.product?.stage ?? '';
  if (stage.startsWith('部分完成') || stage.includes('预算') || stage.includes('AI 提炼未执行')) judgment.push(stage);
  return {
    when: last.completedAt,
    scope: last.product?.scope?.name || last.product?.material?.name || '当前知识库',
    updated: summary.completed.slice(0, 6),
    failed: [...new Set(failed)].slice(0, 6),
    judgment: [...new Set(judgment)].slice(0, 6),
    empty: false,
  };
}
