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
  origins?: {
    gmail?: OriginState;
    meeting?: OriginState;
    conversation?: OriginState;
  };
}

const ORIGIN_ORDER = ['gmail', 'meeting', 'conversation'] as const;

export function WaitingPage() {
  const [data, setData] = useState<WaitingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    gmail: true,
    meeting: true,
    conversation: true,
  });

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

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      const lanes = ORIGIN_ORDER.filter((key) => enabled[key] && data?.origins?.[key]?.ready);
      await api.scanWaiting(lanes);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  if (!data && !error) return <LoadingBlock text="正在读取待我处理…" />;

  const items = (data?.items ?? []).filter((item) => {
    if (item.origin_key === 'other') return true;
    return enabled[item.origin_key] !== false;
  });
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
        <div className="pm-card pm-warn">邮件同步有点旧了，下面名单可能不是最新的。可以先到「连接器」同步 Google。</div>
      )}

      <article className="pm-card daily-card">
        <header>
          <Inbox aria-hidden="true" />
          <div>
            <h2>从哪里发现待办</h2>
            <p>默认会自动查看已连接的来源，也可以先关掉再扫描。</p>
          </div>
        </header>
        <div className="daily-source-pills">
          {ORIGIN_ORDER.map((key) => {
            const origin = origins[key];
            const on = enabled[key] !== false && origin?.ready === true;
            return (
              <button
                type="button"
                key={key}
                className={`daily-source-pill${on ? ' is-on' : ''}`}
                disabled={!origin?.ready}
                onClick={() => setEnabled((current) => ({ ...current, [key]: !on }))}
              >
                <span>{origin?.label ?? key}</span>
                <b>{origin?.ready ? '✅' : '未连接'}</b>
              </button>
            );
          })}
        </div>
        <button type="button" className="pm-primary" disabled={scanning} onClick={() => void scan()}>
          {scanning ? '正在扫描…' : '立即扫描'}
        </button>
      </article>

      {items.length === 0 ? (
        <div className="pm-card daily-empty">
          <Inbox aria-hidden="true" />
          <div>
            <b>暂时没有待处理事项</b>
            <p>
              {data?.no_google_sources
                ? '还没有连接 Gmail。连上后可以扫描邮件里谁在等你；会议和 AI 对话也可以先扫描。'
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
