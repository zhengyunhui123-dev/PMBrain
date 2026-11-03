import React, { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { ConsoleRun } from '../lib/shared';
import { DEEP_ORGANIZE_STAGES, deepOrganizePercent, deepOrganizeTotals, deepStageTitle } from '../../../shared/deep-organize-progress';
import { taskStatus, taskStopping } from './task-presentation';
import { DatabaseSummary, elapsedText } from './MaintenanceProgress';
import { ModelSetupNotice } from './ModelSetupNotice';
import './maintenance-progress.css';

const active = (run: ConsoleRun) => ['running', 'queued'].includes(run.status);
const yuan = (value: number) => `¥${value.toFixed(2)}`;
function useNow(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  return now;
}

export function DeepOrganizeProgress({ run, link = true }: { run: ConsoleRun; link?: boolean }) {
  const now = useNow(active(run));
  const view = run.product;
  const round = view?.deep;
  if (!round) return null;
  const totals = deepOrganizeTotals(round);
  const percent = deepOrganizePercent(round);
  const title = taskStopping(run) ? '正在停止任务' : deepStageTitle(round);
  const spec = DEEP_ORGANIZE_STAGES.find(stage => stage.id === round.stage);
  const file = round.stage === 'sync' && !round.scan.complete ? view?.syncScan?.path : view?.activeFiles?.[0]?.path ?? view?.file ?? round.current?.file;
  const showCurrent = active(run) || ['failed', 'cancelled'].includes(run.status);
  const failure = run.error ?? view?.errorReason;
  const budget = view?.budget;
  return <section className="maintenance-round-progress" aria-label="AI 深度整理进度">
    <section className="mpr-summary" aria-label="整轮总计"><div className="mpr-heading"><h3>{title}<span className={`product-task-state state-${run.status}`}>{taskStatus(run)}</span></h3><span className="mpr-time">总耗时<b>{elapsedText(active(run) ? Math.max(0, now - Date.parse(run.startedAt)) : run.durationMs)}</b></span></div>
      <dl className="mpr-totals deep"><div><dt>同步文件</dt><dd>{round.scan.complete ? totals.files.toLocaleString() : '确定中'}</dd></div><div><dt>知识点</dt><dd>{totals.knowledge.toLocaleString()}</dd></div><div><dt>写入实体</dt><dd>{totals.entities.toLocaleString()}</dd></div><div><dt>新增关联</dt><dd>{totals.links.toLocaleString()}</dd></div></dl>
      <div className="mpr-progress-label"><span>深度整理整体进度 · {round.stages.filter(stage => stage.status === 'completed' || stage.status === 'skipped').length} / {DEEP_ORGANIZE_STAGES.length} 个阶段已记录</span><b>{percent}%</b></div>
      <div className="mpr-overall" role="progressbar" aria-label="深度整理整体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>
      <p className="mpr-note">按 8 个阶段累计。当前阶段完成后才计入。检查和同步使用资料目录；理解内容与新增实体按现有整理规则调用模型。</p>
      {budget && <p className="mpr-note">本次费用 {yuan(budget.spentCny)} / {yuan(budget.capCny)}{budget.reason ? ` · ${budget.reason}` : ''}</p>}
      <ol className="mpr-steps deep">{DEEP_ORGANIZE_STAGES.map((stage, index) => {
        const saved = round.stages.find(item => item.id === stage.id);
        const state = saved ? saved.status === 'failed' || saved.status === 'partial' ? 'is-failed' : 'is-done' : round.stage === stage.id ? 'is-current' : '';
        return <li key={stage.id} className={state}><span>{saved ? saved.status === 'failed' || saved.status === 'partial' ? '!' : '✓' : index + 1}</span>{stage.title}</li>;
      })}</ol>
    </section>
    {showCurrent && <section className="mpr-current" aria-label="当前阶段"><h4>{spec?.title ?? title}<span>{round.current?.result ?? spec?.detail ?? '等待开始'}</span></h4>
      {file && <div className="mpr-document"><FileText size={15} />{file}</div>}
      {spec && <p>{spec.detail}</p>}
      {round.stage === 'sync' && round.scan.complete && <p>本轮清单已固定，未变化 {round.scan.unchanged.toLocaleString()} 份；途中新增的资料留到下一轮。</p>}
      <DatabaseSummary run={run} />
      {failure && <p className="mpr-error" role="alert">{failure}</p>}
      {run.status === 'cancelled' && <p>已完成成果保留，可以继续未完成部分。</p>}
    </section>}
    {round.stages.length > 0 && <section className="mpr-results" aria-label="各阶段结果"><h3>阶段结果</h3>{DEEP_ORGANIZE_STAGES.flatMap(stage => {
      const saved = round.stages.find(item => item.id === stage.id);
      if (!saved) return [];
      return <div key={stage.id} className="mpr-result-row deep"><strong>{stage.title}<small>{saved.status === 'failed' ? '未完成' : saved.status === 'partial' ? '部分完成' : saved.status === 'skipped' ? '无需处理' : '已完成'}</small></strong><span>{saved.result}<small>{saved.detail}{saved.costCny != null ? ` · 本阶段 ${yuan(saved.costCny)}` : ''}</small></span><time>{elapsedText(saved.durationMs)}</time></div>;
    })}</section>}
    <ModelSetupNotice run={run} />
    {link && <footer><button type="button" onClick={() => { window.location.hash = `tasks?run=${encodeURIComponent(run.id)}`; }}>查看任务</button></footer>}
  </section>;
}
