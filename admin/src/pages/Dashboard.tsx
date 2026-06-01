import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';

interface FeedEvent {
  agent: string;
  operation: string;
  scopes: string;
  latency_ms: number;
  status: string;
  timestamp: string;
}

function statusLabel(status: string): string {
  return status === 'success' ? '成功' : status === 'error' ? '错误' : status;
}

export function DashboardPage() {
  const [stats, setStats] = useState({ connected_agents: 0, requests_today: 0, active_tokens: 0 });
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
    api.health().then(setHealth).catch(() => {});

    const es = new EventSource('/admin/events');
    eventSourceRef.current = es;
    es.onopen = () => setSseStatus('connected');
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as FeedEvent;
        setEvents((prev) => [event, ...prev].slice(0, 50));
      } catch {}
    };
    es.onerror = () => {
      setSseStatus('disconnected');
      setTimeout(() => {
        setSseStatus('connecting');
        es.close();
        // Reconnect handled by browser EventSource auto-retry
      }, 3000);
    };

    const interval = setInterval(() => {
      api.stats().then(setStats).catch(() => {});
      api.health().then(setHealth).catch(() => {});
    }, 30000);

    return () => { es.close(); clearInterval(interval); };
  }, []);

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    return `${Math.floor(diff / 3600000)} 小时前`;
  };

  return (
    <>
      <h1 className="page-title">仪表盘</h1>

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: 1 }}>
          <div className="metrics">
            <div className="metric">
              <div className="metric-value">{stats.connected_agents}</div>
              <div className="metric-label">已连接 Agent</div>
            </div>
            <div className="metric">
              <div className="metric-value">{stats.requests_today}</div>
              <div className="metric-label">今日请求数</div>
            </div>
            <div className="metric">
              <div className="metric-value">{stats.active_tokens}</div>
              <div className="metric-label">有效令牌数</div>
            </div>
          </div>

          <h2 className="section-title">
            实时活动
            <span style={{ marginLeft: 8, fontSize: 10, color: sseStatus === 'connected' ? 'var(--success)' : sseStatus === 'connecting' ? 'var(--warning)' : 'var(--error)' }}>
              {sseStatus === 'connected' ? '● 已连接' : sseStatus === 'connecting' ? '● 连接中...' : '● 已断开'}
            </span>
          </h2>

          <div className="feed">
            {events.length === 0 ? (
              <div className="feed-empty">
                {sseStatus === 'connected' ? '暂无请求。Agent 连接后会显示在这里。' : '正在连接...'}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>操作</th>
                    <th>权限范围</th>
                    <th>延迟</th>
                    <th>状态</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event, index) => (
                    <tr key={index}>
                      <td className="mono">{event.agent}</td>
                      <td className="mono">{event.operation}</td>
                      <td>{event.scopes.split(',').map((scope) => (
                        <span key={scope} className={`badge badge-${scope.trim()}`} style={{ marginRight: 4 }}>{scope.trim()}</span>
                      ))}</td>
                      <td className="mono">{event.latency_ms} ms</td>
                      <td><span className={`badge badge-${event.status}`}>{statusLabel(event.status)}</span></td>
                      <td style={{ color: 'var(--text-secondary)' }}>{timeAgo(event.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div style={{ width: 220 }}>
          <h2 className="section-title">令牌状态</h2>
          <div className="health-panel">
            <div className="health-row">
              <span style={{ color: 'var(--warning)' }}>即将过期</span>
              <span className="mono">{health.expiring_soon}</span>
            </div>
            <div className="health-row">
              <span style={{ color: 'var(--error)' }}>错误率</span>
              <span className="mono">{health.error_rate}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
