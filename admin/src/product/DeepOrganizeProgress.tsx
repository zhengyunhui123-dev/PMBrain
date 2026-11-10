import React, { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { ConsoleRun } from '../lib/shared';
import { DEEP_ORGANIZE_STAGES, applyDeepSyncFileCounts, deepOrganizeElapsed, deepOrganizePercent, deepOrganizeRecordedStages, deepOrganizeTotals, deepStageElapsed, deepStageTitle } from '../../../shared/deep-organize-progress';
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
  const elapsed = run.deepTiming ? deepOrganizeElapsed(run.deepTiming, now)
    : run.status === 'running' ? Math.max(0, now - Date.parse(run.startedAt)) : run.durationMs;
  const totals = deepOrganizeTotals(round);
  const contentStages = DEEP_ORGANIZE_STAGES.slice(2, 6);
  const contentTotals = deepOrganizeTotals({ ...round, stages: round.stages.filter(stage => contentStages.some(spec => spec.id === stage.id)) });
  const percent = deepOrganizePercent(round);
  const title = taskStopping(run) ? '正在停止任务' : deepStageTitle(round);
  const legacyIndex = round.stage === 'index';
  const spec = DEEP_ORGANIZE_STAGES.find(stage => stage.id === (legacyIndex ? 'review' : round.stage));
  const file = legacyIndex ? undefined : round.stage === 'sync' && !round.scan.complete ? view?.syncScan?.path : view?.activeFiles?.[0]?.path ?? view?.file ?? round.current?.file;
  const showCurrent = active(run) || ['failed', 'cancelled'].includes(run.status);
  const failure = run.error ?? view?.errorReason;
  const budget = view?.budget;
  const syncFiles = view?.syncFiles;
  const syncing = round.stage === 'sync' && round.scan.complete;
  const syncResult = syncing ? `成功处理 ${syncFiles?.completed ?? 0} / ${round.scan.incremental ?? syncFiles?.total ?? 0} 份${syncFiles?.failed ? `，失败 ${syncFiles.failed} 份` : ''}` : undefined;
  const phaseLogs = (round.log ?? []).filter(entry => entry.stage !== 'index').slice(-8);
  const savedStage = (id: typeof DEEP_ORGANIZE_STAGES[number]['id']) => {
    const saved = round.stages.find(item => item.id === id);
    return saved && applyDeepSyncFileCounts(saved, round.scan, syncFiles);
  };
  const row = (stage: typeof DEEP_ORGANIZE_STAGES[number]) => {
    const saved = savedStage(stage.id);
    const current = round.stage === stage.id && active(run);
    const timing = round.stage === stage.id ? round.current : undefined;
    const stageNow = active(run) ? now : Date.parse(run.completedAt ?? timing?.startedAt ?? '');
    const duration = timing && (timing.elapsedMs != null || current && timing.startedAt)
      ? deepStageElapsed(timing, stageNow) : saved?.durationMs;
    const state = current ? '进行中' : saved ? saved.status === 'failed' ? '未完成' : saved.status === 'partial' ? '部分完成' : saved.status === 'skipped' ? '跳过' : '已完成' : '待执行';
    return <div key={stage.id} className={`mpr-result-row deep${current ? ' is-current' : ''}`}><strong>{stage.title}<small>{state}</small></strong><span>{current ? syncResult ?? timing?.result ?? stage.detail : saved?.result ?? '—'}<small>{current ? stage.detail : saved?.detail ?? ''}</small></span><time>{duration == null ? '—' : elapsedText(duration)}{saved?.costCny != null && <small>{yuan(saved.costCny)}</small>}</time></div>;
  };
  return <section className="maintenance-round-progress" aria-label="AI 深度整理进度">
    <section className="mpr-summary" aria-label="整轮总计"><div className="mpr-heading"><h3>{title}<span className={`product-task-state state-${run.status}`}>{taskStatus(run)}</span></h3><span className="mpr-time">总耗时<b>{elapsedText(elapsed)}</b></span></div>
      <dl className="mpr-totals deep"><div><dt>同步资料</dt><dd>{round.scan.complete ? (syncing ? syncFiles?.completed ?? totals.files : totals.files).toLocaleString() : '确定中'}</dd></div><div><dt>新建 / 维护知识成果</dt><dd>{totals.newKnowledge.toLocaleString()} / {totals.maintainedKnowledge.toLocaleString()}</dd></div><div><dt>写入实体</dt><dd>{totals.entities.toLocaleString()}</dd></div><div><dt>新增及补齐关联</dt><dd>{totals.links.toLocaleString()}</dd></div></dl>
      {totals.unclassifiedKnowledge > 0 && <p className="mpr-note">历史记录另有 {totals.unclassifiedKnowledge} 个知识点，未区分新建与维护。</p>}
      <div className="mpr-progress-label"><span>深度整理整体进度 · {deepOrganizeRecordedStages(round)} / {DEEP_ORGANIZE_STAGES.length} 个阶段已记录</span><b>{percent}%</b></div>
      <div className="mpr-overall" role="progressbar" aria-label="深度整理整体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>
      <p className="mpr-note">阶段完成后保存记录并计入总计。已保存内容的向量由空闲时的自动向量化任务补齐。</p>
      {phaseLogs.length > 0 && <ol className="mpr-note" aria-label="阶段日志">{phaseLogs.map((entry, index) => <li key={`${entry.at}:${entry.stage}:${entry.event}:${index}`}>{entry.event === 'start' ? '开始' : '结束'} {DEEP_ORGANIZE_STAGES.find(stage => stage.id === entry.stage)?.title ?? entry.stage}{entry.event === 'finish' && entry.durationMs != null ? ` · ${elapsedText(entry.durationMs)}` : ''}{entry.result ? ` · ${entry.result}` : ''}</li>)}</ol>}
      {budget && <p className="mpr-note">本次费用 {yuan(budget.spentCny)} / {yuan(budget.capCny)}{budget.reason ? ` · ${budget.reason}` : ''}</p>}
      <ol className="mpr-steps deep">{DEEP_ORGANIZE_STAGES.map((stage, index) => {
        const saved = savedStage(stage.id);
        const state = saved ? saved.status === 'failed' || saved.status === 'partial' ? 'is-failed' : 'is-done' : spec?.id === stage.id ? 'is-current' : '';
        return <li key={stage.id} className={state}><span>{saved ? saved.status === 'failed' || saved.status === 'partial' ? '!' : '✓' : index + 1}</span>{stage.title}</li>;
      })}</ol>
    </section>
    {showCurrent && <section className="mpr-current" aria-label="当前阶段"><h4>{spec?.title ?? title}<span>{syncResult ?? (legacyIndex ? undefined : round.current?.result) ?? spec?.detail ?? '等待开始'}</span></h4>
      {file && <div className="mpr-document"><FileText size={15} />{file}</div>}
      {spec && <p>{spec.detail}</p>}
      {round.stage === 'sync' && round.scan.complete && <p>本轮清单已固定，未变化 {round.scan.unchanged.toLocaleString()} 份；途中新增的资料留到下一轮。</p>}
      <DatabaseSummary run={run} />
      {failure && <p className="mpr-error" role="alert">{failure}</p>}
      {run.status === 'cancelled' && <p>已完成成果保留，可以继续未完成部分。</p>}
    </section>}
    <section className="mpr-results" aria-label="各阶段结果"><h3>阶段记录</h3>{DEEP_ORGANIZE_STAGES.slice(0, 2).map(row)}
      <section className="mpr-content-group" aria-label="理解内容与关联"><h4>理解内容与关联</h4><p>新建 {contentTotals.newKnowledge} 个知识成果 · 维护 {contentTotals.maintainedKnowledge} 个 · 新增关联 {contentTotals.links} 条</p><p className="mpr-note">优先整理本轮新增和变更的资料，同时补做历史积压。四个内容阶段共享 30 分钟软预算，剩余候选留到下一轮。</p>{contentStages.map(row)}</section>
      {DEEP_ORGANIZE_STAGES.slice(6).map(row)}
    </section>
    <ModelSetupNotice run={run} />
    {link && <footer><button type="button" onClick={() => { window.location.hash = `tasks?run=${encodeURIComponent(run.id)}`; }}>查看任务</button></footer>}
  </section>;
}
