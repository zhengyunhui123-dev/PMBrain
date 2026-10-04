import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, CircleAlert, CircleDashed, CircleStop, FileText, LoaderCircle, PenLine, Sparkles, X, XCircle } from 'lucide-react';
import { api } from '../api';
import { formatDate, type ConsoleRun } from '../lib/shared';
import { taskName } from '../../../shared/task-progress';
import { useProductTasks } from './TaskActivity';
import { TaskProgressCard, taskLink, taskStatus, taskStopping } from './TaskProgress';
import './maintenance-tasks.css';

const activeTask = (run: ConsoleRun) => run.status === 'running' || run.status === 'queued';
const selectedTaskId = () => new URLSearchParams(window.location.hash.split('?')[1]).get('run') ?? '';
const description = (run: ConsoleRun) => run.kind.includes('quick') ? '同步资料，建立关联并更新搜索索引' : run.kind.includes('full') || run.kind.includes('cycle') ? '理解知识，提炼内容并建立联系' : '整理知识库中的内容';

function MaintenanceTaskDetail({ run, onClose, onChange }: { run: ConsoleRun; onClose: () => void; onChange: (run: ConsoleRun) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = run.product?.name ?? taskName(run.kind);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const act = async (retry: boolean) => {
    if (busy) return;
    if (retry && !window.confirm('将重新执行整理任务，中断的模型请求可能已产生费用，继续吗？')) return;
    setBusy(true); setError('');
    try {
      if (retry) {
        const accepted = await api.retryRun(run.id);
        onChange(await api.run(accepted.runId));
      } else onChange(await api.cancelRun(run.id) as ConsoleRun);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="maintenance-task-dialog" aria-label={`${name}详情`} onCancel={onClose} onClose={onClose}>
    <header><div><h2>{name}</h2><p>{description(run)}</p></div><button type="button" aria-label="关闭整理详情" onClick={onClose}><X size={20} /></button></header>
    <div className="maintenance-detail-body">
      <div className="maintenance-detail-meta"><span>{run.trigger === 'scheduled' ? '自动任务' : '手动任务'}</span><span>开始于 {formatDate(run.startedAt, '—')}</span></div>
      <TaskProgressCard run={run} link={false} timeline />
      {!run.product && <p className="maintenance-muted">此历史任务没有保存步骤进度，可在任务中心查看结果。</p>}
      {error && <p className="product-error" role="alert">{error}</p>}
    </div>
    <footer>{activeTask(run) && <button type="button" disabled={busy || taskStopping(run)} onClick={() => void act(false)}><CircleStop size={16} />{busy || taskStopping(run) ? '正在停止…' : '停止任务'}</button>}{['failed', 'cancelled'].includes(run.status) && run.id.startsWith('task-') && <button type="button" disabled={busy} onClick={() => void act(true)}>{busy ? '正在提交…' : '重新执行'}</button>}<button type="button" className="maintenance-primary" onClick={() => taskLink(run)}><ArrowUpRight size={16} />查看任务</button></footer>
  </dialog>;
}

export function MaintenanceTasksPage() {
  const tasks = useProductTasks();
  const [localRuns, setLocalRuns] = useState<ConsoleRun[]>([]);
  const [selectedId, setSelectedId] = useState(selectedTaskId);
  const [filter, setFilter] = useState('all');
  const [starting, setStarting] = useState<'quick' | 'full' | ''>('');
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
  const close = () => { setSelectedId(''); window.history.replaceState(null, '', '#dream'); };
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
  const update = (run: ConsoleRun) => {
    setLocalRuns(current => [...current.filter(row => row.id !== run.id), run]);
    if (run.id !== selectedId) select(run);
  };
  const visible = runs.filter(run => filter === 'all' || (filter === 'active' ? activeTask(run) : filter === 'unfinished' ? ['failed', 'cancelled'].includes(run.status) || taskStatus(run) === '部分完成' : run.status === filter));
  return <div className="pm-page maintenance-tasks-page">
    <header className="maintenance-page-head"><div><h1>知识整理</h1><p>查看整理任务、进度和结果。</p></div><div className="maintenance-launch-actions"><button type="button" disabled={Boolean(starting)} onClick={() => void start('quick')}>{starting === 'quick' ? <LoaderCircle size={16} /> : <PenLine size={16} />}快速维护</button><button type="button" className="maintenance-primary" disabled={Boolean(starting)} onClick={() => void start('full')}>{starting === 'full' ? <LoaderCircle size={16} /> : <Sparkles size={16} />}AI 深度整理</button></div></header>
    <div className="maintenance-automation"><span className={`maintenance-dot ${schedule?.enabled ? 'enabled' : ''}`} /><span>{schedule ? schedule.enabled ? `自动整理已开启 · 每天 ${schedule.time}（${schedule.timeZone}）` : '自动整理未开启' : scheduleError || '正在读取自动整理设置…'}</span><button type="button" onClick={() => { window.location.hash = 'settings-dream'; }}>整理设置</button></div>
    {(error || tasks.error) && <p className="product-error" role="alert">{error || tasks.error}</p>}
    <section className="maintenance-run-list" aria-label="整理任务列表">
      <div className="maintenance-list-toolbar"><span>{runs.length} 条整理记录</span><select aria-label="整理任务状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="active">处理中</option><option value="completed">已完成</option><option value="unfinished">未完成</option></select></div>
      <table><thead><tr><th>任务</th><th>状态 / 当前阶段</th><th>更新时间</th><th><span className="maintenance-visually-hidden">操作</span></th></tr></thead><tbody>
        {starting && <tr className="maintenance-submitting"><td><span className="maintenance-run-title">{starting === 'quick' ? '快速维护' : 'AI 深度整理'}</span></td><td><span role="status"><LoaderCircle size={16} />正在创建任务…</span></td><td>—</td><td /></tr>}
        {visible.map(run => {
          const name = run.product?.name ?? taskName(run.kind);
          const state = taskStatus(run) === '部分完成' ? 'partial' : run.status;
          const Icon = state === 'running' ? LoaderCircle : state === 'queued' ? CircleDashed : state === 'partial' ? CircleAlert : state === 'completed' ? CheckCircle2 : state === 'cancelled' ? CircleStop : XCircle;
          return <tr key={run.id} className="maintenance-run-row" tabIndex={0} aria-label={`查看${name}任务`} onClick={() => select(run)} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); select(run); } }}>
            <td><div className="maintenance-run-name"><span className="maintenance-run-icon"><FileText size={20} /></span><div><b>{name}</b><small>{run.trigger === 'scheduled' ? '自动整理 · ' : ''}{description(run)}</small></div></div></td>
            <td><span className={`maintenance-run-state maintenance-state-${state}`}><Icon size={18} />{taskStatus(run)}{run.product?.percent != null && <small>{run.product.percent}%</small>}</span><small className="maintenance-run-stage">{run.product?.errorReason ?? (activeTask(run) ? run.product?.stage ?? '等待执行' : run.product?.metrics.filter(metric => metric.value > 0).slice(0, 2).map(metric => `${metric.label} ${metric.value}`).join(' · ') || run.product?.stage)}</small></td>
            <td><time dateTime={run.completedAt ?? run.startedAt}>{formatDate(run.completedAt ?? run.startedAt, '—')}</time></td><td><button type="button" aria-label={`查看${name}详情`} onClick={event => { event.stopPropagation(); select(run); }}><ArrowUpRight size={17} /></button></td>
          </tr>;
        })}
      </tbody></table>
      {!visible.length && !starting && <div className="maintenance-list-empty"><FileText size={28} /><b>{tasks.loaded ? runs.length ? '没有符合筛选的任务' : '暂无整理记录' : '正在读取任务…'}</b>{tasks.loaded && !runs.length && <span>发起整理后，进度和结果会保存在这里。</span>}</div>}
    </section>
    <p className="maintenance-retention">离开页面不影响后台任务，完成后可在这里查看结果。</p>
    {selected && <MaintenanceTaskDetail key={selected.id} run={localRuns.find(run => run.id === selected.id) ?? selected} onClose={close} onChange={update} />}
  </div>;
}
