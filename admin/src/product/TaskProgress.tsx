import React from 'react';
import { Check, Circle, LoaderCircle, Minus, X } from 'lucide-react';
import type { ConsoleRun } from '../lib/shared';
import { taskName } from '../../../shared/task-progress';
import './tasks.css';

export const taskStatus = (run: ConsoleRun) => run.status === 'completed' && run.product?.stage.startsWith('部分完成') ? '部分完成' : ({ queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止' })[run.status];
export const taskLink = (run: ConsoleRun) => { window.location.hash = `tasks?run=${encodeURIComponent(run.id)}`; };

export function TaskProgressCard({ run, link = true }: { run: ConsoleRun; link?: boolean }) {
  const view = run.product;
  const active = run.status === 'running' || run.status === 'queued';
  const elapsed = run.durationMs === null ? null : Math.max(0, Math.floor(run.durationMs / 1000));
  return <section className="product-task-progress" aria-label={`${view?.name ?? taskName(run.kind)}进度`}>
    <header><div><h3>{view?.name ?? taskName(run.kind)}</h3><p>{view?.file ?? (run.trigger === 'scheduled' ? '自动任务' : '后台任务')}</p></div><span className={`product-task-state state-${run.status}`}>{taskStatus(run)}</span></header>
    <div className="product-task-current" role="status"><b>{run.status === 'failed' ? '任务未完成' : run.status === 'cancelled' ? '任务已停止' : view?.stage ?? (active ? '正在处理' : '任务完成')}</b><span>{view?.percent != null ? `${view.percent}%` : active ? '进行中' : ''}</span></div>
    <div className={`product-task-bar ${active && view?.percent == null ? 'indeterminate' : ''}`} role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view?.percent ?? undefined}><i style={{ width: `${view?.percent ?? (active ? 35 : 0)}%` }} /></div>
    {view && <p className="product-task-caption">{view.scope && active ? `知识源 ${view.scope.index + 1} / ${view.scope.total} · ${view.scope.name} · ` : ''}{view.total != null ? `已处理 ${view.processed ?? 0} / ${view.total} 份资料` : view.steps.length ? `已完成 ${view.completedSteps} / ${view.steps.length} 个步骤 · 按步骤计进度` : '等待处理结果'}{active && view.phasePercent != null ? ` · 当前阶段 ${view.phasePercent}%` : ''}</p>}
    {view?.steps.length ? <ol className="product-task-steps">{view.steps.map(step => { const Icon = step.status === 'completed' ? Check : step.status === 'running' ? LoaderCircle : step.status === 'failed' ? X : step.status === 'skipped' ? Minus : Circle; return <li key={step.id} className={`step-${step.status}`}><Icon size={16} aria-hidden="true" /><span>{step.label}</span><small>{({ completed: '已完成', running: active ? '进行中' : '已停止', skipped: '未执行', failed: '未完成', pending: '待处理' })[step.status]}</small></li>; })}</ol> : null}
    {view?.metrics.length ? <dl className="product-task-metrics">{view.metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl> : null}
    {view?.errorReason && <p className="product-task-error" role="alert">{view.errorReason}</p>}
    {run.status === 'cancelled' && <p className="product-task-caption">已完成的内容会保留。</p>}
    <footer>{elapsed !== null && <small>耗时 {elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</small>}{link && <button type="button" onClick={() => taskLink(run)}>查看任务</button>}</footer>
  </section>;
}
