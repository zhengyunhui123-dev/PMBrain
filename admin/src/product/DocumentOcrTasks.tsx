import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate, type ConsoleRun } from '../lib/shared';
import type { DocumentOcrOverview } from '../../../shared/task-progress';
import { taskCanRetry, taskStatus } from './task-presentation';

export function documentOcrFallback(rows: ConsoleRun[]): DocumentOcrOverview {
  const ocr=rows.filter(run=>run.kind==='document_ocr');
  return {total:ocr.length,queued:ocr.filter(run=>run.status==='queued').length,running:ocr.filter(run=>run.status==='running').length,
    completed:ocr.filter(run=>run.status==='completed').length,failed:ocr.filter(run=>run.status==='failed'||run.status==='paused').length,
    cancelled:ocr.filter(run=>run.status==='cancelled').length,latestAt:ocr[0]?.startedAt??null,
    latestCompletedAt:ocr.find(run=>run.status==='completed')?.completedAt??null};
}

export function documentOcrStatus(summary: DocumentOcrOverview): ConsoleRun['status'] {
  return summary.running>0?'running':summary.queued>0?'queued':summary.failed>0?'failed':summary.cancelled>0?'cancelled':'completed';
}

export function documentOcrMatchesFilter(summary: DocumentOcrOverview, filter: string): boolean {
  if(!summary.total)return false;
  if(filter==='all')return true;
  if(filter==='running')return summary.running>0;
  if(filter==='queued')return summary.queued>0;
  if(filter==='failed')return summary.failed>0;
  if(filter==='cancelled')return summary.cancelled>0;
  if(filter==='completed')return documentOcrStatus(summary)==='completed';
  return false;
}

export function DocumentOcrRow({ summary, counting, onOpen }: { summary: DocumentOcrOverview; counting: boolean; onOpen: () => void }) {
  const status=documentOcrStatus(summary);
  const label=status==='running'?'执行中':status==='queued'?'等待空闲':status==='failed'?'部分未完成':status==='cancelled'?'已停止':'已完成';
  const details=[summary.running?`执行中 ${summary.running} 份`:null,summary.queued?`等待 ${summary.queued} 份`:null,summary.failed?`未完成 ${summary.failed} 份`:null,summary.cancelled?`已停止 ${summary.cancelled} 份`:null].filter(Boolean).join(' · ');
  return <tr>
    <td><button type="button" onClick={onOpen}>图片识别</button><small>资料中的图片文字</small></td>
    <td><span className={`task-status task-status-${status}`}>{label}</span></td>
    <td>{counting?'正在统计':`累计完成 ${summary.completed} / ${summary.total} 份资料`}</td>
    <td>{counting?'正在读取识图任务':details||'图片识别已完成'}</td>
    <td>—</td><td>{counting?'待统计':`${summary.queued+summary.running+summary.failed} 份`}</td>
    <td><div className="task-table-actions"><button type="button" className="pm-ghost" onClick={onOpen}>查看详情</button></div></td>
  </tr>;
}

export function DocumentOcrDrawer({ summary, onClose, onOpen, onCancel, onRetry, busyId }: {
  summary: DocumentOcrOverview; onClose: () => void; onOpen: (run: ConsoleRun) => void;
  onCancel: (run: ConsoleRun) => Promise<void>; onRetry: (run: ConsoleRun) => Promise<void>; busyId: string;
}) {
  const [cursors,setCursors]=useState<Array<number|null>>([null]);
  const [page,setPage]=useState<{rows:ConsoleRun[];next:number|null}|null>(null);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  const cursor=cursors.at(-1)??null;
  useEffect(()=>{
    let live=true;let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try{const next=await api.documentOcrRuns(cursor);if(live){setPage(next);setError('');}}
      catch(reason){if(live)setError(reason instanceof Error?reason.message:String(reason));}
      finally{if(live)timer=setTimeout(load,4000);}
    };
    setPage(null);void load();return()=>{live=false;clearTimeout(timer);};
  },[cursor,revision]);
  const action=async(run:ConsoleRun,fn:(run:ConsoleRun)=>Promise<void>)=>{await fn(run);setRevision(value=>value+1);};
  return <><div className="drawer-overlay" onClick={onClose} /><aside className="drawer task-detail-drawer" aria-label="图片识别任务详情">
    <button type="button" className="drawer-close" aria-label="关闭任务详情" onClick={onClose}>×</button>
    <h2>图片识别</h2><p className="pm-hint">已完成 {summary.completed} 份 · 等待 {summary.queued} 份 · 执行中 {summary.running} 份 · 未完成 {summary.failed} 份</p>
    <p className="pm-hint">识别结果按资料保存；可以查看每份资料的进度和失败原因。</p>
    {error&&<p role="alert">读取图片识别任务失败：{error}</p>}
    {!page&&!error&&<p role="status">正在读取识图任务…</p>}
    {page&&<div className="document-ocr-list">{page.rows.map(run=><article key={run.id}>
      <div><button type="button" onClick={()=>onOpen(run)}>{run.product?.material?.name??run.product?.file??'图片资料'}</button><span className={`task-status task-status-${run.status}`}>{taskStatus(run)}</span></div>
      <p>{formatDate(run.startedAt,'-')} · {run.product?.material?.sourceId?`知识源：${run.product.material.sourceId} · `:''}{run.product?.errorReason??run.product?.stage??'等待执行'}</p>
      <div className="task-run-card-actions"><button type="button" className="pm-ghost" onClick={()=>onOpen(run)}>查看详情</button>
        {['running','queued'].includes(run.status)&&<button type="button" className="pm-ghost" disabled={busyId===run.id} onClick={()=>void action(run,onCancel)}>停止</button>}
        {taskCanRetry(run)&&<button type="button" className="pm-ghost" disabled={busyId===run.id} onClick={()=>void action(run,onRetry)}>重试</button>}
      </div>
    </article>)}</div>}
    {page&&<div className="task-run-card-actions"><button type="button" className="pm-ghost" disabled={cursors.length===1} onClick={()=>setCursors(value=>value.slice(0,-1))}>上一页</button><button type="button" className="pm-ghost" disabled={page.next===null} onClick={()=>setCursors(value=>[...value,page.next!])}>下一页</button></div>}
  </aside></>;
}
