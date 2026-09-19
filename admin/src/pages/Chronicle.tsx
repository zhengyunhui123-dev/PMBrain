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

function EventList({ rows, empty }: { rows: ChronicleRow[]; empty: string }) {
  if (rows.length === 0) return <p className="pm-hint">{empty}</p>;
  return (
    <ul className="daily-loop-list">
      {rows.map((row, index) => (
        <li key={`${row.page_slug ?? row.event_slug ?? row.summary}-${row.date}-${index}`}>
          <div>
            <span className="daily-pill">{row.date.slice(0, 10)}</span>
            <b>{row.summary}</b>
            {row.kind && <small>{row.kind}</small>}
            {row.detail && <p>{row.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ChroniclePage() {
  const [date, setDate] = useState(localDateKey);
  const [today, setToday] = useState<ChronicleRow[] | null>(null);
  const [onThisDay, setOnThisDay] = useState<ChronicleRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [dayPayload, memoryPayload] = await Promise.all([
        api.chronicleDay(date),
        api.chronicleOnThisDay(date),
      ]);
      setToday(asRows(dayPayload));
      setOnThisDay(asRows(memoryPayload));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  if (!today && !onThisDay && !error) return <LoadingBlock text="正在读取生命年表…" />;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            生命年表
            <InfoIcon title="生命年表">
              今天发生过什么、往年的今天有什么。只读已投影的时间线，不会在这个页面重新抽取。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">用日期回顾自己的一天，以及往年同一天留下的事。</p>
        </div>
        <label className="daily-date-field">
          日期
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      <div className="daily-grid">
        <article className="pm-card daily-card">
          <header>
            <CalendarDays aria-hidden="true" />
            <div>
              <h2>这一天</h2>
              <p>{date} 的时间线</p>
            </div>
          </header>
          <EventList rows={today ?? []} empty="这一天还没有年表记录。" />
        </article>
        <article className="pm-card daily-card">
          <header>
            <CalendarDays aria-hidden="true" />
            <div>
              <h2>往年今日</h2>
              <p>以前同一天发生过的事</p>
            </div>
          </header>
          <EventList rows={onThisDay ?? []} empty="往年今日还没有记录。" />
        </article>
      </div>
    </div>
  );
}
