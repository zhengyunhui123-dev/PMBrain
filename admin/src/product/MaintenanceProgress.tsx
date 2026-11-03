import React, { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { ConsoleRun } from '../lib/shared';
import type { DatabaseOccupancy } from '../../../shared/database-occupancy';
import { MAINTENANCE_STAGE_LABELS, maintenancePercent, maintenanceStageSummary, type MaintenanceStageId } from '../../../shared/maintenance-progress';
import { taskStatus, taskStopping } from './task-presentation';
import { productFetch } from '../lib/product-fetch';
import { ImportTaskResult } from './ImportTaskResult';
import { TaskRelationsDetails } from './TaskRelations';
import { ModelSetupNotice } from './ModelSetupNotice';
import './maintenance-progress.css';
import {importOutcome} from '../../../shared/import-outcome';

export const elapsedText=(milliseconds:number|null|undefined)=>{
  if(milliseconds==null||!Number.isFinite(milliseconds))return '暂未记录';
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
};
const active=(run:ConsoleRun)=>['running','queued'].includes(run.status);
const totalElapsed=(run:ConsoleRun,now:number)=>active(run)?Math.max(0,now-Date.parse(run.startedAt)):run.durationMs;
function useNow(running:boolean){const [now,setNow]=useState(Date.now);useEffect(()=>{if(!running)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[running]);return now;}

function OverallBar({percent,label}:{percent:number|null;label:string}){
  return <><div className="mpr-progress-label"><span>{label}</span><b>{percent==null?'正在确定范围':`${percent}%`}</b></div><div className={`mpr-overall${percent==null?' is-unknown':''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent??undefined} aria-valuetext={percent==null?'正在确定范围':undefined}><i style={{width:`${percent??32}%`}} /></div></>;
}

export function DatabaseSummary({run}:{run:ConsoleRun}){
  const [report,setReport]=useState<(DatabaseOccupancy&{supported?:boolean})|null>(null),running=active(run);
  useEffect(()=>{
    if(!running){setReport(null);return;}
    let live=true,timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const response=await productFetch('/admin/api/database-occupancy');if(response.ok){const value=await response.json();if(live)setReport(value);}}catch{if(live)setReport(null);}finally{if(live)timer=setTimeout(load,document.visibilityState==='hidden'?8000:2000);}};
    void load();return()=>{live=false;clearTimeout(timer);};
  },[run.id,running]);
  const stats=run.product?.database,supported=report?.supported!==false&&stats?.supported!==false;
  const holder=report?.holder,own=new Set([Number(run.id.replace(/^task-/,'')),...(run.product?.activeFiles??[]).map(file=>file.id)]);
  const waiting=report?.waiting??[],mine=waiting.filter(request=>request.taskId!=null&&own.has(request.taskId));
  const held=holder?.heldMs;
  const state=!running?'已结束':report?.supported===false?'暂未提供':mine.length?'等待数据库':holder?own.has(holder.taskId??-1)?'本任务处理中':'其他任务占用':report?'空闲':'读取中';
  const operation=holder?.stage??(holder?'读取或保存资料':'');
  return <div className="mpr-database" aria-label="数据库状态"><div>数据库状态<strong>{state}</strong>{holder&&<small>{operation}{held!=null?` · 已占用 ${elapsedText(held)}`:''}</small>}</div><div>数据库排队<strong>{report&&supported?`${waiting.length} 个请求`:'—'}</strong>{mine.length>0&&<small>本任务本次已等待 {elapsedText(Math.max(...mine.map(row=>row.waitedMs)))}</small>}</div><div>本任务请求累计等待<strong>{stats?.supported?elapsedText(stats.waitedMs):'暂未提供'}</strong><small>写入请求 {stats?.supported?stats.writes.toLocaleString():'—'} 次</small></div></div>;
}

export function VectorRoundProgress({runs,title='本轮后台向量化'}:{runs:ConsoleRun[];title?:string}){
  const now=useNow(runs.some(active)),values=runs.flatMap(run=>run.product?.vectorTotals?[run.product.vectorTotals]:[]);
  if(!runs.length)return <section className="mpr-vector"><h3>{title}<small>等待资料处理完成</small></h3><p>只处理本轮增量资料，每个运行窗口最多 30 分钟，保留已完成和剩余数量。</p></section>;
  const known=values.length===runs.length,total=values.reduce((sum,value)=>sum+value.total,0),completed=values.reduce((sum,value)=>sum+value.completed,0);
  const running=runs.some(active),failed=runs.filter(run=>run.status==='failed'),finished=runs.every(run=>run.status==='completed');
  const paused=runs.some(run=>['paused','cancelled'].includes(run.status));
  const percent=known?(total?Math.min(100,Math.round(completed/total*1000)/10):finished?100:0):null;
  const starts=runs.map(run=>Date.parse(run.startedAt)).filter(Number.isFinite),ends=runs.map(run=>Date.parse(run.completedAt??'')).filter(Number.isFinite);
  const elapsed=starts.length?(running?now:ends.length?Math.max(...ends):now)-Math.min(...starts):null;
  const current=runs.find(run=>run.status==='running'),windowEnded=values.some(value=>value.windowEnded);
  return <section className="mpr-vector" aria-label={title}><h3>{title}<small>{failed.length?'未完成':finished?'已完成':paused&&!running?'已暂停':windowEnded&&!current?'本次运行窗口已结束':current?'进行中':'等待后台继续'}</small></h3>
    <p>{known?`已完成 ${completed.toLocaleString()} / ${total.toLocaleString()} 个分块 · ${values.reduce((sum,value)=>sum+value.completedPages,0)} / ${values.reduce((sum,value)=>sum+value.pages,0)} 份资料`:'正在统计本轮向量化范围'}</p>
    <OverallBar percent={percent} label="本轮向量化整体进度" />
    {current?.product?.file&&<p>正在处理：{current.product.file}</p>}
    <div className="mpr-work-queue"><span>总耗时 <b>{elapsedText(elapsed)}</b></span><span>剩余 <b>{known?Math.max(0,total-completed).toLocaleString():'待统计'} 个分块</b></span><span>失败 <b>{failed.length}</b></span></div>
    <p className="mpr-note">每个运行窗口最多 30 分钟；窗口结束保留结果，{paused?'恢复后继续剩余部分。':'剩余部分由后台继续。'}</p>
    {windowEnded&&<p>上一窗口已结束，已完成结果保留。</p>}
    {values.some(value=>value.lastWindow)&&<details><summary>最近运行窗口结果</summary>{values.flatMap((value,index)=>value.lastWindow?<p key={index}>已保存 {value.lastWindow.completed} / {value.lastWindow.total} 个分块 · 剩余 {Math.max(0,value.lastWindow.total-value.lastWindow.completed)} · 窗口耗时 {elapsedText(value.lastWindow.elapsedMs)}</p>:[])}</details>}
    {failed.map(run=><p key={run.id} className="mpr-error" role="alert">{run.error??run.product?.errorReason??'向量化未完成'}</p>)}
    {current&&<DatabaseSummary run={current} />}
  </section>;
}

export function MaintenanceProgress({run,link=true,vectorRuns=[]}:{run:ConsoleRun;link?:boolean;vectorRuns?:ConsoleRun[]}){
  const now=useNow(active(run)),view=run.product,round=view?.maintenance,ordinary=run.kind==='import_path',files=view?.syncFiles;
  const scanned=round?.scan.complete?round.scan.total:round?.scan.scanned,delta=round?.scan.complete?round.scan.incremental:ordinary?view?.total:null;
  const counts=view?.importCounts??importOutcome(run.result),processed=view?.processed??0;
  const imported=ordinary?counts?.imported??0:files?.completed??0;
  const summary=round?maintenanceStageSummary(round,files):{completed:imported,total:delta??null,failed:counts?.failed??0,remaining:delta==null?null:Math.max(0,delta-processed)};
  const activeFiles=active(run)?view?.activeFiles?.length||((round?.current?.file||ordinary&&view?.file)?1:0):0;
  const inFlight=Math.min(summary.remaining??activeFiles,activeFiles),queued=summary.remaining==null?null:Math.max(0,summary.remaining-inFlight);
  const percent=round?maintenancePercent(round,files):delta==null?null:delta===0?100:Math.min(100,Math.round((imported+(counts?.unchanged??0))/delta*1000)/10);
  const currentStage=round&&!round.scan.complete?'扫描资料':round?.stage==='done'?round.stages.some(stage=>stage.status==='partial')?'快速维护部分完成':'快速维护完成':round?MAINTENANCE_STAGE_LABELS[round.stage]:view?.stage??'导入资料';
  const stageLabel=taskStopping(run)?'正在停止任务':currentStage;
  const file=round&&!round.scan.complete?view?.syncScan?.path:round?.stage==='sync'?view?.activeFiles?.[0]?.path:round?.current?.file??(ordinary?view?.file:null);
  const failure=run.error??view?.errorReason,showCurrent=active(run)||['failed','cancelled'].includes(run.status);
  const stageIds:MaintenanceStageId[]=['sync','relations','check'];
  const vectorValue=(run.result as {quickVector?:unknown}|undefined)?.quickVector;
  const receipts=round?.vectors??(Array.isArray(vectorValue)?vectorValue:vectorValue?[vectorValue]:[]) as Array<{taskId?:string;pages?:number;error?:string}>;
  const vectors=vectorRuns.filter(vector=>receipts.some(receipt=>receipt.taskId===vector.id));
  return <section className="maintenance-round-progress" aria-label={`${view?.name??'导入资料'}进度`}>
    <section className="mpr-summary" aria-label="本轮总统计"><div className="mpr-heading"><h3>{stageLabel}<span className={`product-task-state state-${run.status}`}>{taskStatus(run)}</span></h3><span className="mpr-time">{ordinary?'总耗时':'维护总耗时'}<b>{elapsedText(totalElapsed(run,now))}</b></span></div>
      <dl className="mpr-totals"><div><dt>{round&&!round.scan.complete?'已扫描资料':ordinary?'资料总数':'扫描资料总数'}</dt><dd>{ordinary?(view?.total?.toLocaleString()??'确定中'):(scanned?.toLocaleString()??'确定中')}</dd></div><div><dt>{ordinary?'本轮导入总数':'本轮增量资料'}</dt><dd>{delta?.toLocaleString()??'确定中'}</dd></div><div><dt>已导入 / 本轮总数</dt><dd>{imported.toLocaleString()} <small>/ {delta?.toLocaleString()??'确定中'}</small></dd></div></dl>
      {ordinary&&counts&&<p className="mpr-note">未变化 {counts.unchanged} 份 · 失败 {counts.failed} 份 · 部分导入 {counts.partial} 份</p>}
      <OverallBar percent={percent} label={ordinary?'导入整体进度':'快速维护整体进度'} />
      <p className="mpr-note">{round&&!round.scan.complete?'扫描完成后确定本轮增量清单，再开始导入。':ordinary?'按本轮资料总数累计进度。':'按 3 个阶段累计，阶段内按本轮资料数量推进；后台向量化单独统计。'}</p>
      {round&&<ol className="mpr-steps">{stageIds.map((id,index)=>{const result=round.stages.find(stage=>stage.id===id);return <li key={id} className={result?result.status==='partial'?'is-failed':'is-done':round.stage===id?'is-current':''}><span>{result?result.status==='partial'?'!':'✓':index+1}</span>{MAINTENANCE_STAGE_LABELS[id]}</li>;})}</ol>}
    </section>
    {showCurrent&&<section className="mpr-current" aria-label="当前处理内容"><h4>{stageLabel}<span>{summary.completed} / {summary.total??'待统计'} {round?.stage==='sync'||ordinary?'份资料':'页'}</span></h4>
      {file&&<div className="mpr-document"><FileText size={15} />{file}</div>}
      {round?.stage==='relations'&&<><p>只关联已有的人物、项目、组织和公司；不调用生成模型，不新增或改写实体知识。</p><div className="mpr-entities"><span>已关联 <b>{round.entities.total}</b> 个已有实体（去重）</span><span>人物 {round.entities.person} · 项目 {round.entities.project} · 组织 {round.entities.organization} · 公司 {round.entities.company}</span></div><p>共 {round.entities.links} 条关联 · 本轮新增写入 {view?.relations?.total??0} 条</p></>}
      {round?.stage==='check'&&<p>检查本轮资料的页面标记和事实表边界，保留原始资料。</p>}
      {round?.stage==='sync'&&round.scan.complete&&<p>本轮清单已固定，未变化 {round.scan.unchanged.toLocaleString()} 份；途中新增的资料留到下一轮。</p>}
      <div className="mpr-work-queue"><span>处理中 <b>{inFlight} 份</b></span><span>待处理 <b>{queued??'待统计'} 份</b></span><span>失败 <b>{summary.failed} 份</b></span></div>
      <DatabaseSummary run={run}/>
      {failure&&<p className="mpr-error" role="alert">{failure}</p>}
      {run.status==='cancelled'&&<p>已完成成果保留，可以继续未完成部分。</p>}
    </section>}
    {round&&round.stages.length>0&&<section className="mpr-results" aria-label="各阶段统计结果"><h3>阶段结果</h3>{stageIds.flatMap(id=>{const stage=round.stages.find(stage=>stage.id===id);if(!stage)return[];const wait=view?.database?.stages[id];return <div key={id} className="mpr-result-row"><strong>{MAINTENANCE_STAGE_LABELS[id]}<small>{stage.status==='partial'?'部分完成':stage.status==='skipped'?'无需处理':'已完成'}</small></strong><span>{stage.completed} / {stage.total} {id==='sync'?'份资料':'页'}{id==='sync'?` · 失败 ${stage.failed??0}`:id==='relations'?` · ${stage.entities??0} 个已有实体 · ${stage.links??0} 条关联`:` · 修正 ${stage.repaired??0} 处`}<small>数据库累计等待 {view?.database?.supported?elapsedText(wait?.waitedMs??0):'暂未提供'}</small></span><time>{elapsedText(stage.durationMs)}</time></div>;})}</section>}
    {round?.stages.find(stage=>stage.id==='relations')?.failures?.map((failure,index)=><p className="mpr-error" role="alert" key={`${failure.sourceId}:${failure.slug??''}:${index}`}><strong>{failure.sourceId}{failure.path||failure.slug?` / ${failure.path??failure.slug}`:''} · {failure.step}</strong><br/>{failure.error}</p>)}
    {round?.stages.find(stage=>stage.id==='relations')?.detail&&<p className="mpr-note">{round.stages.find(stage=>stage.id==='relations')!.detail}</p>}
    {ordinary&&!active(run)&&<ImportTaskResult run={run}/>}
    {round&&(round.stage!=='done'||receipts.length>0)&&<VectorRoundProgress runs={vectors}/>}
    {receipts.filter(receipt=>receipt.error).map((receipt,index)=><p key={index} className="mpr-error" role="alert">{receipt.error}</p>)}
    {round?.stage==='done'&&!receipts.length&&<p className="mpr-note">{round.scan.incremental===0?'本轮没有变化，无需关联、检查或向量化。':'本轮未提交后台向量任务。'}</p>}
    <TaskRelationsDetails run={run}/><ModelSetupNotice run={run}/>
    {!!view?.gitResults?.length&&<details><summary>本地版本记录</summary>{view.gitResults.map(git=><p key={git.sourceId}>{git.sourceId} · {git.committed?`已提交 ${git.files.length} 个文件`:`待提交 ${git.pending.length} 个文件`}{git.error?` · ${git.error}`:''}</p>)}</details>}
    {link&&<footer><button type="button" onClick={()=>{window.location.hash=`tasks?run=${encodeURIComponent(run.id)}`;}}>查看任务</button></footer>}
  </section>;
}
