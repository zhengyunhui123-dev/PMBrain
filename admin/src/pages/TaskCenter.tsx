import React, { useEffect, useMemo, useState } from 'react';
import { Eye, ListTodo, Power, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { api } from '../api';
import { formatDate, RunOutput, type ConsoleRun } from '../lib/shared';

type TaskFilter = 'all' | 'completed' | 'failed' | 'cancelled';

interface TaskCenterSnapshot {
  mode: 'pglite' | 'postgres';
  pglite_busy: boolean;
  pglite_owner?: PgliteOwnerStatus | null;
  rows: ConsoleRun[];
  queue: {
    queue_health?: { waiting: number; active: number; stalled: number };
    ts_ms?: number;
  } | null;
  server_time: string;
}

interface PgliteOwnerStatus {
  state: 'clear' | 'current' | 'active' | 'stale' | 'unavailable';
  pid: number | null;
  ownerType: string | null;
  commandLabel: string | null;
  acquiredAt: string | null;
  canTerminate: boolean;
  message: string;
}

function taskTitle(kind: string): string {
  if (kind.startsWith('dream_')) {
    if (kind.includes('quick')) return '快速维护';
    if (kind.includes('meeting')) return 'AI 会议整理';
    if (kind.includes('full') || kind.includes('cycle')) return 'AI 深度整理';
    return '知识整理';
  }
  return ({
    import_path: '文件导入',
    export_markdown: 'Markdown 导出',
    embed_stale: '重新向量化',
    sync_all: '知识源同步',
    source_add: '添加知识源',
    source_git_init: '初始化知识源 Git',
    source_git_commit: '提交知识源变更',
    doctor_check: '系统健康检查',
    capture_memory: '保存知识内容',
    search_brain: '知识搜索',
  } as Record<string, string>)[kind] ?? kind;
}

function taskOrigin(kind: string): string {
  if (kind.startsWith('dream_')) return '知识整理';
  if (kind === 'embed_stale') return '导入与向量化';
  if (kind === 'import_path') return '知识工作台';
  if (kind === 'sync_all') return '知识库';
  return '后台任务';
}

function taskTriggerLabel(_kind: string): string {
  // ConsoleRun currently has no explicit trigger field; Admin ConsoleRun is manual.
  return '手动';
}

function taskModelUsageLines(run: ConsoleRun): string[] {
  const lines: string[] = [`触发方式：${taskTriggerLabel(run.kind)}`];
  if (run.kind.includes('quick')) {
    lines.push('普通模型：未使用');
    lines.push('向量模型：可能使用（embed 阶段）');
  } else if (run.kind.startsWith('dream_')) {
    lines.push('普通模型：使用（任务需开启全局开关）');
    lines.push('向量模型：可能使用（embed 阶段）');
  } else if (run.kind === 'embed_stale') {
    lines.push('普通模型：未使用');
    lines.push('向量模型：使用');
  } else if (run.kind === 'search_brain') {
    lines.push('普通模型：综合回答路径可能使用');
  } else {
    lines.push('普通模型：通常未使用');
  }
  if (run.startedAt) lines.push(`开始：${formatDate(run.startedAt, '-')}`);
  if (run.completedAt) lines.push(`结束：${formatDate(run.completedAt, '-')}`);
  return lines;
}

function statusLabel(status: ConsoleRun['status']): string {
  return ({ queued: '等待中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status];
}

function statusClass(status: ConsoleRun['status']): string {
  return `task-status task-status-${status}`;
}

function elapsedLabel(run: ConsoleRun): string {
  const started = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(end)) return '耗时未知';
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  if (seconds < 60) return `已运行 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  return `已运行 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function isActive(run: ConsoleRun): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function isToday(value: string | null): boolean {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function PgliteRecoveryCard({
  owner,
  onTerminate,
  terminating,
}: {
  owner: PgliteOwnerStatus;
  onTerminate: () => void;
  terminating: boolean;
}) {
  const active = owner.state === 'active';
  const title = active ? '发现残留 PGLite 占用进程' : owner.state === 'stale' ? '发现已退出的 PGLite 残留锁' : 'PGLite 连接需要人工确认';
  const stateLabel = active ? '需要恢复' : owner.state === 'stale' ? '可自动清理' : '无法确认';
  return (
    <section className="task-recovery-section">
      <div className="task-section-head">
        <div><span className="pm-eyebrow"><ShieldAlert aria-hidden="true" /> DATABASE RECOVERY</span><h2>PGLite 连接恢复</h2></div>
        <span className="task-status task-status-failed">{stateLabel}</span>
      </div>
      <article className="task-recovery-card">
        <div className="task-recovery-card-head">
          <div><h3>{title}</h3><p>{owner.message}</p></div>
          {owner.pid && <span className="task-recovery-pid">PID {owner.pid}</span>}
        </div>
        <div className="task-recovery-meta">
          <span>进程来源：{owner.commandLabel ?? owner.ownerType ?? '未知'}</span>
          {owner.acquiredAt && <span>占用开始：{formatDate(owner.acquiredAt, '-')}</span>}
        </div>
        {active && owner.canTerminate && owner.pid && (
          <div className="task-run-card-actions">
            <button type="button" className="pm-ghost danger" onClick={onTerminate} disabled={terminating}>
              <Power aria-hidden="true" /> {terminating ? '正在结束…' : '结束占用进程'}
            </button>
            <span className="pm-hint">只结束该 PMBrain 进程树，不删除数据库。</span>
          </div>
        )}
        {active && !owner.canTerminate && <p className="task-recovery-hint">当前无法安全结束这个进程，请先确认它不是正在运行的其他 PMBrain 实例。</p>}
        {owner.state === 'stale' && <p className="task-recovery-hint">进程已经停止，刷新或重新启动服务即可让 PGLite 自动归档残留锁。</p>}
      </article>
    </section>
  );
}

function TaskCard({
  run,
  onView,
  onCancel,
  cancelling,
}: {
  run: ConsoleRun;
  onView: (run: ConsoleRun) => void;
  onCancel: (run: ConsoleRun) => void;
  cancelling: boolean;
}) {
  return (
    <article className={`task-run-card ${isActive(run) ? 'task-run-card-active' : ''}`}>
      <div className="task-run-card-head">
        <div>
          <span className="task-origin">{taskOrigin(run.kind)}</span>
          <h3>{taskTitle(run.kind)}</h3>
        </div>
        <span className={statusClass(run.status)}>{statusLabel(run.status)}</span>
      </div>
      <div className="task-run-card-meta">
        <span>{run.status === 'queued' ? '等待数据库任务空闲后开始' : elapsedLabel(run)}</span>
        <span>发起于 {formatDate(run.startedAt, '-')}</span>
      </div>
      <ul className="task-run-usage">
        {taskModelUsageLines(run).map(line => <li key={line}>{line}</li>)}
      </ul>
      {run.status === 'cancelled' ? (
        <p className="task-run-cancelled">任务已取消，已完成的部分已保留，不会自动回滚。</p>
      ) : run.error ? (
        <p className="task-run-error">{run.error}</p>
      ) : null}
      <div className="task-run-card-actions">
        <button type="button" className="pm-ghost" onClick={() => onView(run)}>
          <Eye aria-hidden="true" /> 查看详情
        </button>
        {isActive(run) && (
          <button type="button" className="pm-ghost danger" onClick={() => onCancel(run)} disabled={cancelling}>
            <XCircle aria-hidden="true" /> {cancelling ? '正在取消…' : run.status === 'queued' ? '取消等待' : '安全取消'}
          </button>
        )}
      </div>
    </article>
  );
}

function TaskDetailDrawer({
  run,
  onClose,
}: {
  run: ConsoleRun;
  onClose: () => void;
}) {
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer task-detail-drawer" aria-label="任务详情">
        <button type="button" className="drawer-close" aria-label="关闭任务详情" onClick={onClose}>×</button>
        <span className="task-origin">{taskOrigin(run.kind)}</span>
        <h2>{taskTitle(run.kind)}</h2>
        <p className="pm-hint">任务编号：{run.id}</p>
        <div className="task-detail-grid">
          <div><span>状态</span><b className={statusClass(run.status)}>{statusLabel(run.status)}</b></div>
          <div><span>开始时间</span><b>{formatDate(run.startedAt, '-')}</b></div>
          <div><span>结束时间</span><b>{formatDate(run.completedAt, '仍在运行')}</b></div>
          <div><span>耗时</span><b>{elapsedLabel(run)}</b></div>
        </div>
        {run.error && run.status !== 'cancelled' && (
          <section className="task-detail-result task-detail-result-error">
            <h3>错误</h3>
            <p>{run.error}</p>
          </section>
        )}
        {run.status === 'cancelled' && (
          <section className="task-detail-result task-detail-result-cancelled">
            <h3>取消说明</h3>
            <p>任务已由管理员取消。已经完成的内容会保留，不会自动回滚；“Run cancelled by admin user”只是后台记录的取消原因，不是新的数据库错误。</p>
          </section>
        )}
        <section className="task-detail-result">
          <h3>执行结果</h3>
          <p>{run.status === 'completed' ? '任务已完成，可以返回发起页面查看业务结果。' : run.status === 'cancelled' ? '任务已取消，已经完成的部分不会自动回滚。' : '任务尚未完成，详细结果会在结束后显示。'}</p>
        </section>
        <details className="task-technical-details">
          <summary>查看技术详情</summary>
          <RunOutput run={run} />
        </details>
      </aside>
    </>
  );
}

export function TaskCenterPage() {
  const [snapshot, setSnapshot] = useState<TaskCenterSnapshot | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [selectedRun, setSelectedRun] = useState<ConsoleRun | null>(null);
  const [cancelling, setCancelling] = useState('');
  const [terminatingOwner, setTerminatingOwner] = useState<number | null>(null);

  const load = async () => {
    try {
      setSnapshot(await api.taskCenter() as TaskCenterSnapshot);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedRun || !snapshot) return;
    const latest = snapshot.rows.find(run => run.id === selectedRun.id);
    if (latest) setSelectedRun(latest);
  }, [snapshot, selectedRun?.id]);

  const rows = snapshot?.rows ?? [];
  const activeRows = rows.filter(isActive);
  const waitingRows = rows.filter(run => run.status === 'queued');
  const failedRows = rows.filter(run => run.status === 'failed');
  const completedToday = rows.filter(run => run.status === 'completed' && isToday(run.completedAt)).length;
  const historyRows = useMemo(() => rows
    .filter(run => !isActive(run))
    .filter(run => filter === 'all' || run.status === filter)
    .slice(0, 30), [filter, rows]);

  const cancel = async (run: ConsoleRun) => {
    if (!window.confirm(run.status === 'queued'
      ? '取消等待后，本次任务不会再启动。确定取消吗？'
      : '取消任务不会删除已经完成的成果，下次可以从未完成部分继续。确定取消吗？')) return;
    setCancelling(run.id);
    try {
      await api.cancelRun(run.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling('');
    }
  };

  const terminateOwner = async () => {
    const owner = snapshot?.pglite_owner;
    if (!owner?.canTerminate || !owner.pid) return;
    if (!window.confirm(
      `这会结束 PID ${owner.pid} 的 PMBrain 占用进程树，但不会删除数据库、锁文件或知识数据。仅在确认它是中止任务留下的残留进程时继续。确定结束吗？`,
    )) return;
    setTerminatingOwner(owner.pid);
    setError('');
    try {
      await api.terminatePgliteOwner(owner.pid);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTerminatingOwner(null);
    }
  };

  if (error && !snapshot) {
    return <div className="pm-page task-center-page"><div className="pm-card pm-error task-state-card"><h2>任务中心暂时不可用</h2><p>{error}</p><button type="button" className="pm-ghost" onClick={() => void load()}><RefreshCw aria-hidden="true" /> 重试</button></div></div>;
  }

  if (!snapshot) {
    return <div className="pm-page task-center-page"><div className="pm-card pm-empty task-state-card">正在读取后台任务…</div></div>;
  }

  return (
    <div className="pm-page task-center-page">
      <div className="pm-section-head">
        <div>
          <span className="pm-eyebrow"><ListTodo aria-hidden="true" /> BACKGROUND TASKS</span>
          <h1>任务中心</h1>
          <p className="pm-page-intro">各功能页面负责发起任务，任务中心负责查看进度、处理错误、安全取消和恢复残留进程。</p>
        </div>
        <button type="button" className="pm-ghost" onClick={() => void load()}><RefreshCw aria-hidden="true" /> 刷新状态</button>
      </div>

      {snapshot.pglite_busy && (
        <div className="task-busy-banner">
          <div><b>个人本地模式正在执行数据库任务</b><span>页面可以继续查看任务；PGLite 会自动排队，避免多个进程同时打开数据库。</span></div>
          <span className="task-busy-dot">运行中</span>
        </div>
      )}

      {error && <div className="pm-error task-inline-error">{error}</div>}

      {snapshot.pglite_owner && snapshot.pglite_owner.state !== 'clear' && snapshot.pglite_owner.state !== 'current' && (
        <PgliteRecoveryCard
          owner={snapshot.pglite_owner}
          onTerminate={() => void terminateOwner()}
          terminating={terminatingOwner === snapshot.pglite_owner.pid}
        />
      )}

      <div className="task-status-grid">
        <div className="task-status-card task-status-card-running"><span>运行中</span><strong>{activeRows.filter(run => run.status === 'running').length}</strong><small>后台正在执行</small></div>
        <div className="task-status-card task-status-card-waiting"><span>等待中</span><strong>{waitingRows.length}</strong><small>等待资源空闲</small></div>
        <div className="task-status-card task-status-card-failed"><span>失败</span><strong>{failedRows.length}</strong><small>需要查看错误</small></div>
        <div className="task-status-card task-status-card-completed"><span>今日完成</span><strong>{completedToday}</strong><small>当前服务记录</small></div>
      </div>

      <div className="task-mode-strip">
        <div><span className="task-mode-label">当前运行模式</span><b>{snapshot.mode === 'pglite' ? '个人本地模式' : 'PostgreSQL 模式'}</b></div>
        <p>{snapshot.mode === 'pglite' ? '后台数据库任务将自动排队，优先保证本地知识库安全。' : '后台任务由任务中心统一管理，允许多个任务按资源情况运行。'}</p>
        {snapshot.queue?.queue_health && <span className="task-queue-summary">队列：等待 {snapshot.queue.queue_health.waiting} · 活跃 {snapshot.queue.queue_health.active} · 停滞 {snapshot.queue.queue_health.stalled}</span>}
      </div>

      <section className="task-section">
        <div className="task-section-head"><div><span className="pm-eyebrow">LIVE QUEUE</span><h2>正在运行和等待</h2></div><span className="pm-hint">{activeRows.length} 个任务</span></div>
        {activeRows.length > 0 ? <div className="task-run-grid">{activeRows.map(run => <TaskCard key={run.id} run={run} onView={setSelectedRun} onCancel={cancel} cancelling={cancelling === run.id} />)}</div> : <div className="task-empty">当前没有正在运行的后台任务。</div>}
      </section>

      <section className="task-section">
        <div className="task-section-head"><div><span className="pm-eyebrow">RECENT HISTORY</span><h2>历史任务</h2></div><div className="task-filter-bar" role="tablist" aria-label="历史任务筛选">
          {([['all', '全部'], ['completed', '已完成'], ['failed', '失败'], ['cancelled', '已取消']] as Array<[TaskFilter, string]>).map(([value, label]) => <button key={value} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
        </div></div>
        {historyRows.length > 0 ? <div className="task-history-list">{historyRows.map(run => <TaskCard key={run.id} run={run} onView={setSelectedRun} onCancel={cancel} cancelling={cancelling === run.id} />)}</div> : <div className="task-empty">当前筛选下没有任务记录。</div>}
        <p className="task-retention-note">当前显示 PMBrain 服务进程保留的任务记录；跨重启的历史持久化和断点续跑将在任务中心后续阶段接入。</p>
      </section>

      {selectedRun && <TaskDetailDrawer run={selectedRun} onClose={() => setSelectedRun(null)} />}
    </div>
  );
}
