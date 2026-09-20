import React, { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';
import { LoadingBlock } from './console-shared';

interface WaitingItem {
  id: number;
  title: string;
  meta: string;
  origin_key: 'gmail' | 'meeting' | 'conversation' | 'other';
  deep_link?: string;
  quote?: string;
}

interface OriginState {
  ready: boolean;
  label: string;
}

interface WaitingSnapshot {
  items?: WaitingItem[];
  count?: number;
  stale?: boolean;
  no_google_sources?: boolean;
  automation_enabled?: boolean;
  origins?: {
    gmail?: OriginState;
    meeting?: OriginState;
    conversation?: OriginState;
  };
}

interface PersonRecord {
  source_id: string;
  slug: string;
  title: string;
  source_label: string;
}

interface PersonSuggestion {
  left: PersonRecord;
  right: PersonRecord;
  reason: string;
}

const ORIGIN_ORDER = ['gmail', 'meeting', 'conversation'] as const;

export function WaitingPage() {
  const [data, setData] = useState<WaitingSnapshot | null>(null);
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | string | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [waiting, people] = await Promise.all([
        api.waiting() as Promise<WaitingSnapshot>,
        api.people('') as Promise<{ suggestions?: PersonSuggestion[] }>,
      ]);
      setData(waiting);
      setSuggestions(people.suggestions ?? []);
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

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      await api.scanWaiting();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const decidePerson = async (suggestion: PersonSuggestion, same: boolean) => {
    const key = `${suggestion.left.source_id}:${suggestion.left.slug}|${suggestion.right.source_id}:${suggestion.right.slug}`;
    setBusyId(key);
    setError('');
    try {
      if (same) {
        await api.mergePeople([suggestion.left, suggestion.right]);
      } else {
        await api.rejectPeople({ left: suggestion.left, right: suggestion.right });
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (!data && !error) return <LoadingBlock text="正在读取待我处理…" />;

  const items = data?.items ?? [];
  const origins = data?.origins ?? {};

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            待我处理
            <InfoIcon title="待我处理">
              PMBrain 会从邮件、会议和 AI 对话里找出谁在等你、你答应过什么。你可以随时标记完成或忽略。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">把该回的消息和答应过的事放在一起处理。</p>
        </div>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {data?.stale && (
        <div className="pm-card pm-warn">邮件同步有点旧了，下面名单可能不是最新的。可以先到「设置 → 数据连接」检查 Google。</div>
      )}

      <article className="pm-card daily-card">
        <header>
          <Inbox aria-hidden="true" />
          <div>
            <h2>{data?.automation_enabled ? '已自动检查' : '自动检查未开启'}</h2>
            <p>{data?.automation_enabled ? '新数据进入后会自动判断；重新检查只用于异常补救。' : '可在「设置 → 自动维护」开启，以后由后台自动运行。'}</p>
          </div>
        </header>
        <div className="daily-source-pills">
          {ORIGIN_ORDER.map((key) => {
            const origin = origins[key];
            return (
              <span
                key={key}
                className={`daily-source-pill${origin?.ready ? ' is-on' : ''}`}
              >
                <span>{origin?.label ?? key}</span>
                <b>{origin?.ready ? '✅' : '未连接'}</b>
              </span>
            );
          })}
        </div>
        <button type="button" className="pm-ghost" disabled={scanning} onClick={() => void scan()}>
          {scanning ? '正在检查…' : '重新检查'}
        </button>
      </article>

      {suggestions.length > 0 && (
        <section className="daily-stack" aria-label="需要确认">
          <div className="pm-section-head"><div><h2>需要确认</h2><p className="pm-hint">PMBrain 只提示可能的关联，不会自动合并人物。</p></div></div>
          {suggestions.map((suggestion) => {
            const key = `${suggestion.left.source_id}:${suggestion.left.slug}|${suggestion.right.source_id}:${suggestion.right.slug}`;
            return (
              <article className="pm-card daily-card" key={key}>
                <div>
                  <span className="daily-pill">可能是同一个人</span>
                  <h2>{suggestion.left.title} ↔ {suggestion.right.title}</h2>
                  <p>{suggestion.left.source_label} · {suggestion.left.title} ↔ {suggestion.right.source_label} · {suggestion.right.title}</p>
                </div>
                <div className="daily-loop-actions">
                  <button type="button" className="pm-primary" disabled={busyId === key} onClick={() => void decidePerson(suggestion, true)}>是同一个人</button>
                  <button type="button" className="pm-ghost" disabled={busyId === key} onClick={() => void decidePerson(suggestion, false)}>不是同一个人</button>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {items.length === 0 ? (
        <div className="pm-card daily-empty">
          <Inbox aria-hidden="true" />
          <div>
            <b>暂时没有待处理事项</b>
            <p>
              {data?.no_google_sources
                ? '还没有连接 Gmail。连上后，PMBrain 会自动找出需要回复和跟进的事。'
                : '当前没有需要回复或跟进的事项。'}
            </p>
          </div>
        </div>
      ) : (
        <ul className="daily-loop-list">
          {items.map((item) => (
            <li key={item.id}>
              <div>
                <b>{item.title}</b>
                {item.meta && <small>{item.meta}</small>}
                {item.quote && <blockquote>{item.quote}</blockquote>}
                {item.deep_link && <a href={item.deep_link} target="_blank" rel="noreferrer">打开原件</a>}
              </div>
              <div className="daily-loop-actions">
                <button type="button" className="pm-primary" disabled={busyId === item.id} onClick={() => void closeLoop(item.id, 'done')}>
                  {busyId === item.id ? '处理中…' : '已完成'}
                </button>
                <button type="button" className="pm-ghost" disabled={busyId === item.id} onClick={() => void closeLoop(item.id, 'dropped')}>
                  忽略
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
