import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';
import { LoadingBlock } from './console-shared';

interface ChronicleRow {
  date: string;
  summary: string;
  detail?: string;
  source?: string;
  page_slug?: string;
  event_slug?: string | null;
  kind?: string | null;
}

interface ChronicleStatus {
  enabled?: boolean;
  event_count?: number;
  history_count?: number;
  knowledge_count?: number;
}

function localDateKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function asRows(payload: unknown): ChronicleRow[] {
  if (Array.isArray(payload)) return payload as ChronicleRow[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown }).events)) {
    return (payload as { events: ChronicleRow[] }).events;
  }
  return [];
}

function EventList({
  rows,
  empty,
  onHide,
}: {
  rows: ChronicleRow[];
  empty: string;
  onHide: (slug: string) => void;
}) {
  if (rows.length === 0) return <p className="pm-hint">{empty}</p>;
  return (
    <ul className="daily-loop-list">
      {rows.map((row, index) => {
        const slug = row.event_slug || row.page_slug;
        return (
          <li key={`${slug ?? row.summary}-${row.date}-${index}`}>
            <div>
              <span className="daily-pill">{row.date.slice(0, 10)}</span>
              <b>{row.summary}</b>
              {row.detail && <p>{row.detail}</p>}
            </div>
            {slug && (
              <button type="button" className="pm-ghost" onClick={() => onHide(slug)}>这条不对</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ChroniclePage() {
  const [date, setDate] = useState(localDateKey);
  const [today, setToday] = useState<ChronicleRow[] | null>(null);
  const [onThisDay, setOnThisDay] = useState<ChronicleRow[] | null>(null);
  const [status, setStatus] = useState<ChronicleStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [dayPayload, memoryPayload, statusPayload] = await Promise.all([
        api.chronicleDay(date),
        api.chronicleOnThisDay(date),
        api.chronicleStatus(),
      ]);
      setToday(asRows(dayPayload));
      setOnThisDay(asRows(memoryPayload));
      setStatus(statusPayload as ChronicleStatus);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const hide = async (slug: string) => {
    try {
      await api.hideChronicleEvent(slug);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const enable = async () => {
    setBusy('enable');
    try {
      await api.enableChronicle();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const organize = async () => {
    setBusy('history');
    try {
      await api.organizeChronicleHistory();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!today && !onThisDay && !status && !error) return <LoadingBlock text="正在读取生命年表…" />;

  const empty = (status?.event_count ?? 0) === 0 && (today ?? []).length === 0 && (onThisDay ?? []).length === 0;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            生命年表
            <InfoIcon title="生命年表">
              PMBrain 可以把会议、对话和重要事件整理成时间线。整理结果可以修改或标成不对。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">用日期回顾自己的一天，以及往年同一天留下的事。</p>
        </div>
        {!empty && (
          <label className="daily-date-field">
            日期
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        )}
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}

      {empty ? (
        <div className="pm-card daily-empty-hero">
          <CalendarDays aria-hidden="true" />
          <div>
            <b>PMBrain 可以把会议、对话和重要事件整理成时间线。</b>
            <div className="daily-loop-actions">
              <button type="button" className="pm-primary" disabled={busy === 'enable' || status?.enabled === true} onClick={() => void enable()}>
                {status?.enabled ? '时间记忆已开启' : busy === 'enable' ? '正在开启…' : '开启时间记忆'}
              </button>
            </div>
            {(status?.history_count ?? 0) > 0 && (
              <p>
                已有 {status?.history_count} 条历史知识，可补充过去的时间线。
              </p>
            )}
            {(status?.history_count ?? 0) > 0 && (
              <button type="button" className="pm-ghost" disabled={busy === 'history'} onClick={() => void organize()}>
                {busy === 'history' ? '正在整理…' : '整理历史记录'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="daily-grid">
          <article className="pm-card daily-card">
            <header>
              <CalendarDays aria-hidden="true" />
              <div>
                <h2>这一天</h2>
                <p>{date} 的时间线</p>
              </div>
            </header>
            <EventList rows={today ?? []} empty="这一天还没有记录。" onHide={(slug) => void hide(slug)} />
          </article>
          <article className="pm-card daily-card">
            <header>
              <CalendarDays aria-hidden="true" />
              <div>
                <h2>往年今日</h2>
                <p>以前同一天发生过的事</p>
              </div>
            </header>
            <EventList rows={onThisDay ?? []} empty="往年今日还没有记录。" onHide={(slug) => void hide(slug)} />
          </article>
        </div>
      )}
      {!empty && (status?.history_count ?? 0) > 0 && (
        <p className="pm-hint">
          还有 {status?.history_count} 条历史记录可以补充。
          <button type="button" className="pm-ghost" disabled={busy === 'history'} onClick={() => void organize()}>
            {busy === 'history' ? '正在整理…' : '整理历史记录'}
          </button>
        </p>
      )}
    </div>
  );
}
