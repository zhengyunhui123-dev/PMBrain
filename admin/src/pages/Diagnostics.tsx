import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { RunOutput, type ConsoleRun } from '../lib/shared';
import { MetricCard, pct, useOverview } from './console-shared';
export function SystemDiagnosticPage() {
  const { overview, reload } = useOverview();
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [doctorRuns, setDoctorRuns] = useState<ConsoleRun[]>([]);
  const [error, setError] = useState('');

  const loadDoctorRuns = async () => {
    const data = await api.runs() as { rows: ConsoleRun[] };
    const rows = data.rows.filter(row => row.kind === 'doctor_check');
    setDoctorRuns(rows);
    if (!run && rows.length > 0) setRun(rows[0]);
  };

  useEffect(() => {
    loadDoctorRuns().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const next = await api.run(run.id) as ConsoleRun;
        if (!alive) return;
        setRun(next);
        if (next.status !== 'running' && next.status !== 'queued') {
          await loadDoctorRuns();
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  const runDoctor = async () => {
    setError('');
    try {
      const res = await api.startActionRun('doctor_check') as { runId: string };
      setRun(await api.run(res.runId) as ConsoleRun);
      await loadDoctorRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="pm-page system-diagnostic-page">
      <div className="pm-section-head page-command-head"><h1>系统诊断</h1></div>
      {overview && (
        <div className="pm-grid metrics-grid">
          <MetricCard label="数据库" value={overview.engine} hint={overview.recent_write_at ? '可读取' : '无最近写入'} />
          <MetricCard label="Embedding" value={pct(overview.embedding_coverage)} hint={`${overview.pending_embeddings} pending`} />
          <MetricCard label="Sources" value={overview.sources.length} hint={`${overview.federated_source_count} federated`} />
          <MetricCard label="LLM" value={overview.llm_enabled ? '已配置' : '未配置'} />
        </div>
      )}
      <div className="pm-card">
        <div className="pm-actions">
          <button className="pm-primary" onClick={() => void runDoctor()}>运行 doctor --fast</button>
          <button className="pm-ghost" onClick={() => void reload()}>刷新状态</button>
        </div>
        {error && <div className="pm-error-text">{error}</div>}
        {doctorRuns.length > 0 && (
          <div className="diagnostic-history">
            <h2>本次服务运行记录</h2>
            {doctorRuns.slice(0, 5).map(item => (
              <button
                key={item.id}
                className={run?.id === item.id ? 'active' : ''}
                onClick={() => setRun(item)}
              >
                <span>{new Date(item.startedAt).toLocaleString()}</span>
                <b className={`run-${item.status}`}>{item.status}</b>
              </button>
            ))}
          </div>
        )}
        {run && <RunOutput run={run} />}
      </div>
    </div>
  );
}
