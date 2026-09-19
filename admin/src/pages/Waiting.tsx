import React, { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';
import { LoadingBlock } from './console-shared';

const LOOP_TYPE_LABEL: Record<string, string> = {
  commitment_owed_by_me: '我答应了别人',
  commitment_owed_to_me: '别人答应了我',
  unanswered_inbound: '待我回复',
  unanswered_outbound: '等待对方回复',
  decision_pending: '待决定',
};

interface LoopView {
  id: number;
  loop_type: string;
  summary: string;
  due_at: string | null;
  last_activity_at: string;
  quote?: string;
  deep_link?: string;
}

interface WaitingGroup {
  counterparty: string;
  counterparty_slug: string | null;
  loop_count: number;
  nearest_due_at: string | null;
  loops: LoopView[];
}

interface WaitingSnapshot {
  groups?: WaitingGroup[];
  count?: number;
  stale?: boolean;
  no_google_sources?: boolean;
  lanes?: {
    google?: { configured?: boolean; last_sync_at?: string | null };
    meeting?: { scanned?: number; last_scan_at?: string | null };
  };
  text?: string;
}

function ageLabel(iso: string): string {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
  if (!Number.isFinite(days)) return '';
  if (days === 0) return '今天';
  return `${days} 天前`;
}

export function WaitingPage() {
  const [data, setData] = useState<WaitingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.waiting() as WaitingSnapshot);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const closeLoop = async (id: number, status: 'done' | 'dropped') => {
    setBusyId(id);
    try {
      await api.closeWaiting({ id, status });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (!data && !error) return <LoadingBlock text="正在读取待我处理…" />;

  const groups = data?.groups ?? [];
  const noGoogle = data?.no_google_sources === true;
  const empty = groups.length === 0;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            待我处理
            <InfoIcon title="待我处理">
              显示谁在等你回复、你答应过什么。数据来自同一套 open_loops，不会在页面里重新扫描邮箱。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">把该回的邮件和会议上的承诺放在一起，方便随手处理。</p>
        </div>
        <button type="button" className="pm-ghost" onClick={() => void load()}>刷新</button>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {data?.stale && (
        <div className="pm-card pm-warn">Google 同步有点旧了，下面名单可能不是最新的。请先到「连接器」同步。</div>
      )}
      {empty && (
        <div className="pm-card daily-empty">
          <Inbox aria-hidden="true" />
          {noGoogle ? (
            <div>
              <b>Google 未配置</b>
              <p>这不是收件箱已清零。连上 Google 后才能看到邮件里谁在等你。会议事项需要先运行扫描。</p>
              {data?.lanes?.meeting && (
                <p className="pm-hint">
                  会议已扫描 {data.lanes.meeting.scanned ?? 0} 条
                  {data.lanes.meeting.last_scan_at ? `，最近一次 ${data.lanes.meeting.last_scan_at}` : '，尚未扫描'}。
                </p>
              )}
            </div>
          ) : (
            <div>
              <b>暂时没有待处理事项</b>
              <p>Gmail 通道当前没有超过一天未回的邮件，也没有跟踪中的承诺。</p>
            </div>
          )}
        </div>
      )}
      <div className="daily-stack">
        {groups.map((group) => (
          <article className="pm-card daily-card" key={`${group.counterparty}-${group.counterparty_slug ?? ''}`}>
            <header>
              <div>
                <h2>{group.counterparty}</h2>
                <p>{group.loop_count} 件待处理{group.nearest_due_at ? ` · 最近到期 ${group.nearest_due_at.slice(0, 10)}` : ''}</p>
              </div>
            </header>
            <ul className="daily-loop-list">
              {group.loops.map((loop) => (
                <li key={loop.id}>
                  <div>
                    <span className="daily-pill">{LOOP_TYPE_LABEL[loop.loop_type] ?? loop.loop_type}</span>
                    <b>{loop.summary}</b>
                    <small>{ageLabel(loop.last_activity_at)}{loop.due_at ? ` · 截止 ${loop.due_at.slice(0, 10)}` : ''}</small>
                    {loop.quote && <blockquote>{loop.quote}</blockquote>}
                    {loop.deep_link && <a href={loop.deep_link} target="_blank" rel="noreferrer">打开邮件</a>}
                  </div>
                  <div className="daily-loop-actions">
                    <button type="button" className="pm-primary" disabled={busyId === loop.id} onClick={() => void closeLoop(loop.id, 'done')}>
                      {busyId === loop.id ? '处理中…' : '已处理'}
                    </button>
                    <button type="button" className="pm-ghost" disabled={busyId === loop.id} onClick={() => void closeLoop(loop.id, 'dropped')}>
                      不再跟踪
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}
