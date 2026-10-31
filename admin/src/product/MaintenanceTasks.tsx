import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, CircleStop, Clock3, FileText, LoaderCircle, PenLine, Settings, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, type ConsoleRun } from '../lib/shared';
import { taskName, taskUsesFileQueue } from '../../../shared/task-progress';
import { useProductTasks } from './TaskActivity';
import { TaskProgressCard, taskLink, taskStatus, taskStopping, formatFileBytes } from './TaskProgress';
import './maintenance-tasks.css';
import type { SyncFileDetails } from '../../../shared/task-progress';
import { taskCanRetry, taskHasRemaining, taskPercent, taskRoundCompleted, taskRoundListSummary } from './task-presentation';
import { dialogBackdropClick } from '../lib/dialog-backdrop';

const activeTask = (run: ConsoleRun) => run.status === 'running' || run.status === 'queued';
const selectedTaskId = () => new URLSearchParams(window.location.hash.split('?')[1]).get('run') ?? '';
const description = (run: ConsoleRun) => run.kind.includes('quick') ? '同步变化资料并关联已有实体；不进行新实体建档、图片识别或向量化' : run.kind.includes('full') || run.kind.includes('cycle') ? '理解知识，提炼内容并建立联系' : '整理知识库中的内容';

function MaintenanceTaskDetail({ run, onClose, onAction, onStop, busy, error }: { run: ConsoleRun; onClose: () => void; onAction: (run: ConsoleRun, retry: boolean) => void; onStop: (run: ConsoleRun) => void; busy: boolean; error: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<SyncFileDetails | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileError, setFileError] = useState('');
  const [filesOpen,setFilesOpen]=useState(false);
  const name = run.product?.name ?? taskName(run.kind);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const readFiles = async (after = 0) => {
    if (loadingFiles) return;
    setLoadingFiles(true); setFileError('');
    try {
      const value = await api.runFiles(run.id, after);
      setFiles(current => ({...value, rows: after && current ? [...current.rows, ...value.rows] : value.rows }));
    } catch (reason) { setFileError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoadingFiles(false); }
  };
  useEffect(()=>{
    if(!filesOpen||!activeTask(run)||loadingFiles||(files?.rows.length??0)>50)return;
    const timer=setTimeout(()=>void readFiles(),2000);return()=>clearTimeout(timer);
  },[filesOpen,run.id,run.status,files,loadingFiles]);
  return <dialog ref={dialog} className="maintenance-task-dialog" aria-label={`${name}详情`} onCancel={onClose} onClose={onClose} onClick={event=>dialogBackdropClick(event,onClose)}>
    <header><div><h2>{name}</h2><p>{description(run)}</p></div><button type="button" aria-label="关闭整理详情" onClick={onClose}><X size={20} /></button></header>
    <div className="maintenance-detail-body">
      <div className="maintenance-detail-meta"><span>{run.trigger === 'scheduled' ? '自动任务' : '手动任务'}</span><span>开始于 {formatDate(run.startedAt, '—')}</span></div>
      <TaskProgressCard run={run} link={false} timeline />
      {taskUsesFileQueue(run.kind) && run.product?.syncFiles && <details onToggle={event => {setFilesOpen(event.currentTarget.open); if (event.currentTarget.open && !files && !loadingFiles) void readFiles(); }}><summary>查看同步文件明细</summary>
        {files?.updatedAt && <p className="maintenance-muted">状态更新于 {new Date(files.updatedAt).toLocaleTimeString()}</p>}
        {files?.rows.map(file => <p key={file.id}><b>{file.path}</b> · {file.sourceId} · {({ completed: '已完成', failed: '失败', running: '处理中', pending: '未处理' })[file.status]}{file.activity && <span> · {formatFileBytes(file.activity.bytes)} · {file.activity.stage}</span>}{file.error && <span> · {file.error}</span>}</p>)}
        {fileError && <p role="alert">{fileError}</p>}
        <button type="button" disabled={loadingFiles} onClick={() => void readFiles()}>{loadingFiles ? '读取中…' : '刷新文件状态'}</button>
        {files?.next != null && <button type="button" disabled={loadingFiles} onClick={() => void readFiles(files.next!)}>加载更多</button>}
      </details>}
      {!run.product && <p className="maintenance-muted">此历史任务没有保存步骤进度，可在任务中心查看结果。</p>}
      {error && <p className="product-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={onClose}>关闭</button>{activeTask(run) && <button type="button" className="maintenance-stop" disabled={busy || taskStopping(run)} onClick={() => onStop(run)}><CircleStop size={16} />{busy || taskStopping(run) ? '正在停止…' : '停止任务'}</button>}{taskCanRetry(run) && <button type="button" disabled={busy} onClick={() => onAction(run, true)}>{busy ? '正在提交…' : taskUsesFileQueue(run.kind)||run.status==='completed' ? '继续未完成任务' : '重新执行'}</button>}<button type="button" className="maintenance-primary" onClick={() => taskLink(run)}><ArrowUpRight size={16} />查看任务</button></footer>
  </dialog>;
}

function MaintenanceStopDialog({ run, busy, error, onClose, onConfirm }: { run: ConsoleRun; busy: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const name = run.product?.name ?? taskName(run.kind);
  const percent = taskPercent(run);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="maintenance-task-dialog maintenance-stop-dialog" aria-label={`停止「${name}」？`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} onClick={event => { if (!busy) dialogBackdropClick(event, onClose); }}>
    <header><h2>停止「{name}」？</h2><button type="button" aria-label="关闭停止确认" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    <div className="maintenance-detail-body"><p className="maintenance-stop-explanation">停止任务不会删除已经完成的成果，下次可以从未完成部分继续。</p><div className="maintenance-stop-summary"><strong>{name}</strong><span>{percent != null ? `${percent}% · ` : ''}{run.product?.stage ?? description(run)}</span></div>{error && <p className="product-error" role="alert">{error}</p>}</div>
    <footer><button type="button" disabled={busy} onClick={onClose}>继续运行</button><button type="button" className="maintenance-stop" disabled={busy} onClick={onConfirm}>{busy ? '正在停止…' : '确认停止'}</button></footer>
  </dialog>;
}

export function MaintenanceTasksPage() {
  const tasks = useProductTasks();
  const [localRuns, setLocalRuns] = useState<ConsoleRun[]>([]);
  const [selectedId, setSelectedId] = useState(selectedTaskId);
  const [filter, setFilter] = useState('all');
  const [starting, setStarting] = useState<'quick' | 'full' | ''>('');
  const [busyId, setBusyId] = useState('');
  const acting = useRef(false);
  const [stopRun, setStopRun] = useState<ConsoleRun | null>(null);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [schedule, setSchedule] = useState<{ enabled: boolean; time: string; timeZone: string } | null>(null);
  const [scheduleError, setScheduleError] = useState('');
  useEffect(() => {
    const select = () => setSelectedId(selectedTaskId());
    window.addEventListener('hashchange', select);
    let live = true;
    void api.dreamSchedule().then(value => { if (live) setSchedule(value); }).catch(reason => { if (live) setScheduleError(String(reason)); });
    return () => { live = false; window.removeEventListener('hashchange', select); };
  }, []);
  useEffect(() => { setLocalRuns(current => current.filter(run => !tasks.rows.some(row => row.id === run.id && (activeTask(run) || !activeTask(row))))); }, [tasks.rows]);
  const runs = [...new Map([...tasks.rows, ...localRuns].map(run => [run.id, run])).values()].filter(run => run.kind.startsWith('dream_')).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selected = runs.find(run => run.id === selectedId);
  useEffect(() => {
    if (!selectedId || selected) return;
    let live = true;
    void api.run(selectedId).then(run => { if (live && run.kind.startsWith('dream_')) setLocalRuns(current => [...current.filter(row => row.id !== run.id), run]); }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [selectedId, Boolean(selected)]);
  const select = (run: ConsoleRun) => { setSelectedId(run.id); window.history.replaceState(null, '', `#dream?run=${encodeURIComponent(run.id)}`); };
  const close = () => {
    setSelectedId('');
    if ((window.location.hash.replace(/^#/, '').split('?')[0] || 'home') === 'dream') window.history.replaceState(null, '', '#dream');
  };
  const start = async (preset: 'quick' | 'full') => {
    if (submitting.current) return;
    submitting.current = true; setStarting(preset); setError('');
    try {
      const sourceId = preset === 'full' ? (await api.brainOverview()).main_source_id : undefined;
      const accepted = await api.startDreamRun({ preset, dryRun: false, allSources: preset === 'quick', sourceId });
      const run = await api.run(accepted.runId);
      setFilter('all'); setLocalRuns(current => [...current.filter(row => row.id !== run.id), run]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setStarting(''); }
  };
  const act = async (run: ConsoleRun, retry: boolean) => {
    if (acting.current) return;
    if (retry && !window.confirm(run.kind.includes('quick') ? '将保留已完成资料，继续未完成的同步与关联。继续吗？' : taskUsesFileQueue(run.kind) ? '将保留已完成资料，继续未完成的同步和知识增强。中断的模型请求可能已产生费用，继续吗？' : '将重新执行整理任务，中断的模型请求可能已产生费用，继续吗？')) return;
    acting.current = true; setBusyId(run.id); setError('');
    try {
      let id = run.id;
      if (retry) id = (await api.retryRun(run.id)).runId;
      else await api.cancelRun(run.id);
      const updated = await api.run(id);
      setLocalRuns(current => [...current.filter(row => row.id !== updated.id), updated]);
      if (selectedId === run.id && id !== run.id) select(updated);
      if (!retry) setStopRun(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { acting.current = false; setBusyId(''); }
  };
  const requestStop = (run: ConsoleRun) => { setError(''); setStopRun(run); };
  const visible = runs.filter(run => filter === 'all' || (filter === 'active' ? activeTask(run) : filter === 'unfinished' ? ['failed', 'cancelled'].includes(run.status) || taskCanRetry(run) || (taskRoundCompleted(run) && taskHasRemaining(run)) : run.status === filter));
  return <div className="pm-page maintenance-tasks-page">
    <header className="maintenance-page-head"><div><h1>知识整理</h1><p>查看整理任务、进度和结果。快速维护只关联已有实体；新实体建档和向量化留待深度整理。</p></div><div className="maintenance-launch-actions"><button type="button" disabled={Boolean(starting)} onClick={() => void start('quick')}>{starting === 'quick' ? <LoaderCircle size={16} /> : <PenLine size={16} />}快速维护</button><button type="button" className="maintenance-primary" disabled={Boolean(starting)} onClick={() => void start('full')}>{starting === 'full' ? <LoaderCircle size={16} /> : <Sparkles size={16} />}AI 深度整理</button></div></header>
    <div className="maintenance-automation"><span className={`maintenance-automation-icon ${schedule?.enabled ? 'enabled' : ''}`}><Clock3 size={18} /></span><span>{schedule ? <><strong>自动整理{schedule.enabled ? '已开启' : '已关闭'}</strong><small>{schedule.enabled ? `每天 ${schedule.time} · ${schedule.timeZone}` : '可在整理设置中安排自动运行'}</small></> : <strong>{scheduleError || '正在读取自动整理设置…'}</strong>}</span><button type="button" onClick={() => { window.location.hash = 'settings-dream'; }}><Settings size={15} />整理设置</button></div>
    {(error || tasks.error) && <p className="product-error" role="alert">{error || tasks.error}</p>}
    <div className="maintenance-list-toolbar"><h2>整理记录 <span>{visible.length} 条</span></h2><div><select aria-label="整理任务状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="active">处理中</option><option value="completed">已完成</option><option value="unfinished">未完成</option></select><button type="button" onClick={() => { window.location.hash = 'tasks'; }}>全部后台任务 <ArrowRight size={15} /></button></div></div>
    <section className="maintenance-run-list" aria-label="整理任务列表">
      <table><thead><tr><th>任务</th><th>状态</th><th>处理进度</th><th>时间</th><th>操作</th></tr></thead><tbody>
        {starting && <tr className="maintenance-submitting"><td><span className="maintenance-run-title">{starting === 'quick' ? '快速维护' : 'AI 深度整理'}</span></td><td><span role="status"><LoaderCircle size={16} />正在创建任务…</span></td><td>准备处理</td><td>—</td><td /></tr>}
        {visible.map(run => {
          const name = run.product?.name ?? taskName(run.kind);
          const state = run.kind.includes('quick') && taskStatus(run) === '部分完成' ? 'partial' : run.status;
          const percent=taskPercent(run);
          return <tr key={run.id} className="maintenance-run-row" tabIndex={0} aria-label={`查看${name}任务`} onClick={() => select(run)} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); select(run); } }}>
            <td><div className="maintenance-run-name"><span className="maintenance-run-icon">{run.kind.includes('quick') ? <PenLine size={18} /> : <Sparkles size={18} />}</span><div><b>{name}</b><small>{run.trigger === 'scheduled' ? '自动整理' : '手动整理'}{run.product?.scope?.name ? ` · ${run.product.scope.name}` : ''}</small></div></div></td>
            <td><span className={`maintenance-run-state maintenance-state-${state}`}>{taskStatus(run)}</span></td>
            <td><div className="maintenance-run-progress">{percent != null && <div className="maintenance-progress-bar" role="progressbar" aria-label={`${name}处理进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>}<small className="maintenance-run-stage">{percent != null ? `${percent}% · ` : ''}{taskRoundCompleted(run)?taskRoundListSummary(run):run.product?.errorReason ?? (activeTask(run) ? run.product?.stage ?? '等待执行' : run.product?.metrics.filter(metric => metric.value > 0).slice(0, 2).map(metric => `${metric.label} ${metric.value}`).join(' · ') || run.product?.stage)}</small></div></td>
            <td><time dateTime={run.completedAt ?? run.startedAt}>{formatDate(run.completedAt ?? run.startedAt, '—')}</time></td><td><div className="maintenance-run-actions"><button type="button" aria-label={`查看${name}详情`} onClick={event => { event.stopPropagation(); select(run); }}>详情</button>{activeTask(run) && <button type="button" className="maintenance-stop" disabled={Boolean(busyId) || taskStopping(run)} onClick={event => { event.stopPropagation(); requestStop(run); }}>{busyId === run.id || taskStopping(run) ? '正在停止…' : '停止'}</button>}{taskCanRetry(run) && <button type="button" disabled={Boolean(busyId)} onClick={event => { event.stopPropagation(); void act(run, true); }}>{busyId === run.id ? '提交中…' : taskUsesFileQueue(run.kind)||run.status==='completed' ? '继续' : '重新执行'}</button>}</div></td>
          </tr>;
        })}
      </tbody></table>
      {!visible.length && !starting && <div className="maintenance-list-empty"><FileText size={28} /><b>{tasks.loaded ? runs.length ? '没有符合筛选的任务' : '暂无整理记录' : '正在读取任务…'}</b>{tasks.loaded && !runs.length && <span>发起整理后，进度和结果会保存在这里。</span>}</div>}
    </section>
    <p className="maintenance-retention">离开页面不影响后台任务，完成后可在这里查看结果。</p>
    {selected && <MaintenanceTaskDetail key={selected.id} run={localRuns.find(run => run.id === selected.id) ?? selected} onClose={close} onAction={(run, retry) => void act(run, retry)} onStop={requestStop} busy={Boolean(busyId)} error={error} />}
    {stopRun && <MaintenanceStopDialog run={runs.find(run => run.id === stopRun.id) ?? stopRun} busy={Boolean(busyId)} error={error} onClose={() => { if (!acting.current) setStopRun(null); }} onConfirm={() => void act(stopRun, false)} />}
  </div>;
}
