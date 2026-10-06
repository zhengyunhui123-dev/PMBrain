import React, { useEffect, useState } from 'react';
import { Check, Circle, LoaderCircle, Minus, X } from 'lucide-react';
import type { ConsoleRun } from '../lib/shared';
import { taskName } from '../../../shared/task-progress';
import './tasks.css';

export const taskStopping = (run: ConsoleRun) => run.status === 'running' && run.error === '正在停止任务…';
export const taskStatus = (run: ConsoleRun) => taskStopping(run) ? '正在停止' : run.status === 'completed' && run.product?.stage.startsWith('部分完成') ? '部分完成' : ({ queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止' })[run.status];
export const taskLink = (run: ConsoleRun) => { window.location.hash = `tasks?run=${encodeURIComponent(run.id)}`; };

const stepDescriptions: Record<string, string> = { check: '检查知识内容与引用', sync: '将新增和更新的资料同步到知识库', relations: '分析内容并建立知识之间的联系', embed: '更新向量与关键词搜索索引', finish: '检查整理后的知识状态', synthesize: '阅读并理解资料中的新增内容', extract_atoms: '从资料中提炼长期知识', patterns: '识别知识中重复出现的模式', synthesize_concepts: '归纳相关知识与概念', propose_takes: '整理资料中的观点', consolidate: '整理重复的知识内容' };
export const formatFileBytes=(bytes:number)=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(2)} MB`:`${(bytes/1024).toFixed(1)} KB`;
const operations:Record<string,string>={putPage:'保存知识正文',upsertChunks:'写入分块',updateChunkEmbedding:'写入向量',setPageAliases:'保存检索名称',getPage:'读取知识状态',getChunks:'读取已有分块','transaction.open':'开始正文事务','scope.close':'提交或回滚事务',executeRaw:'更新数据库记录'};

export function TaskProgressCard({ run, link = true, timeline = false }: { run: ConsoleRun; link?: boolean; timeline?: boolean }) {
  const view = run.product;
  const active = run.status === 'running' || run.status === 'queued';
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[active]);
  const elapsed = run.durationMs === null ? null : Math.max(0, Math.floor(run.durationMs / 1000));
  return <section className={`product-task-progress${active ? ' task-is-active' : ''}${timeline ? ' product-task-timeline' : ''}`} aria-label={`${view?.name ?? taskName(run.kind)}进度`}>
    <header><div><h3>{view?.name ?? taskName(run.kind)}</h3><p>{view?.file ?? (run.trigger === 'scheduled' ? '自动任务' : '后台任务')}</p></div><span className={`product-task-state state-${run.status}`}>{taskStatus(run)}</span></header>
    <div className="product-task-current" role="status"><b>{taskStopping(run) ? view?.stage==='停止当前操作并恢复数据库'?view.stage:'正在停止并回滚当前操作' : run.status === 'failed' ? '任务未完成' : run.status === 'cancelled' ? '任务已停止' : view?.stage ?? (active ? '正在处理' : '任务完成')}</b><span>{view?.percent != null ? `${view.percent}%` : active ? '进行中' : ''}</span></div>
    <div className={`product-task-bar ${active && view?.percent == null ? 'indeterminate' : ''}`} role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view?.percent ?? undefined}><i style={{ width: `${view?.percent ?? (active ? 35 : 0)}%` }} /></div>
    {view && <p className="product-task-caption">{view.scope && active ? `知识源 ${view.scope.index + 1} / ${view.scope.total} · ${view.scope.name} · ` : ''}{active && view.syncScan?.active ? `正在检查 ${view.syncScan.scanned}${view.syncScan.total!=null?` / ${view.syncScan.total}`:''} 份资料` : view.total != null ? `已处理 ${view.processed ?? 0} / ${view.total} 份资料` : view.steps.length ? `已完成 ${view.completedSteps} / ${view.steps.length} 个步骤 · 按步骤计进度` : '等待处理结果'}{active && view.phasePercent != null ? ` · 当前阶段 ${view.phasePercent}%` : ''}</p>}
    {view?.syncFiles && <p className="product-task-caption" aria-label="同步文件统计">本任务文件队列 · 待同步 {view.syncFiles.total} · 已完成 {view.syncFiles.completed} · 失败 {view.syncFiles.failed} · 未处理 {view.syncFiles.remaining}</p>}
    {view?.syncScan && <p className="product-task-caption">已检查 {view.syncScan.scanned} · 未变化 {view.syncScan.unchanged}</p>}
    {active && view?.syncScan?.active && <div className="product-active-files" aria-label="当前检查资料"><article><b>{view.syncScan.path}</b>
      <p>{view.syncScan.bytes!=null?`${formatFileBytes(view.syncScan.bytes)} · `:''}核对文件变化与已有知识；检查完成后继续处理文件队列。</p>
      {view.syncScan.updatedAt && <small>最近活动：{Math.max(0,Math.floor((now-Date.parse(view.syncScan.updatedAt))/1000))} 秒前</small>}
    </article></div>}
    {active && view?.activeFiles?.length ? <div className="product-active-files" aria-label="当前处理资料">{view.activeFiles.map(file=><article key={file.id}>
      <b>{file.path}</b><p>{file.sourceId} · {formatFileBytes(file.bytes)} · {file.stage}</p>
      {file.chunksTotal!=null && <p>已切分 {file.chunksTotal} / {file.chunksTotal} 块{file.bodyWritten!=null?` · 正文${(file.bodyBatchesTotal??0)>1||file.bodyCommitted?'已提交':'已写入'} ${file.bodyWritten} / ${file.chunksTotal} 块`:''}{file.bodyBatchesTotal!=null?` · 已完成 ${file.bodyBatchesCompleted??0} / ${file.bodyBatchesTotal} 批${file.bodyCommitted?'':` · 正在写入第 ${Math.min((file.bodyBatchesCompleted??0)+1,file.bodyBatchesTotal)} 批`}`:file.bodyWritten!=null?file.bodyCommitted?' · 正文已提交':' · 当前事务尚未提交':''}</p>}
      {file.noEmbed?<p>本轮同步未启用向量化，搜索索引在后续步骤更新。</p>:file.embedded!=null?<p>向量已生成 {file.generated??0} · 已写入 {file.embedded} · 复用 {file.reused??0} · 待处理 {file.pending??0} · 完成 {file.batchesCompleted??0} 批</p>:null}
      {file.operation && <p role="status">正在等待数据库：{operations[file.operation]??'读取或保存资料'} · {Math.max(0,Math.floor((now-Date.parse(file.operationStartedAt??file.updatedAt))/1000))} 秒</p>}
      <small>最近活动：{Math.max(0,Math.floor((now-Date.parse(file.updatedAt))/1000))} 秒前 · {new Date(file.updatedAt).toLocaleTimeString()}</small>
    </article>)}</div>:null}
    {view?.steps.length ? <ol className="product-task-steps" aria-label={timeline ? '执行步骤' : undefined}>{view.steps.map(step => {
      const Icon = step.status === 'completed' ? Check : step.status === 'running' ? active ? LoaderCircle : Circle : step.status === 'failed' ? X : step.status === 'skipped' ? Minus : Circle;
      return <li key={step.id} className={`step-${step.status}`}><Icon size={16} aria-hidden="true" /><span>{step.label}{timeline && stepDescriptions[step.id] && <span className="task-step-description">{stepDescriptions[step.id]}</span>}{timeline && active && step.status === 'running' && view.phasePercent != null && <span className="task-step-progress"><span className="product-task-bar" role="progressbar" aria-label="当前步骤进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.phasePercent}><i style={{ width: `${view.phasePercent}%` }} /></span><span>{view.phasePercent}%</span></span>}</span><small>{({ completed: '已完成', running: active ? '进行中' : '已停止', skipped: '未执行', failed: '未完成', pending: '待处理' })[step.status]}</small></li>;
    })}</ol> : null}
    {view?.metrics.length ? <dl className="product-task-metrics">{view.metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl> : null}
    {view?.detail && <p className="product-task-caption">{view.detail}</p>}
    {view?.errorReason && <p className="product-task-error" role="alert">{view.errorReason}</p>}
    {run.status === 'cancelled' && <p className="product-task-caption">已完成的内容会保留。</p>}
    <footer>{elapsed !== null && <small>耗时 {elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</small>}{link && <button type="button" onClick={() => taskLink(run)}>查看任务</button>}</footer>
  </section>;
}
