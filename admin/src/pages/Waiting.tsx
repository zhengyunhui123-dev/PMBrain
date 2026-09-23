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

export function WaitingPage() {
  const [data, setData] = useState<WaitingSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const waiting = await api.waiting() as WaitingSnapshot;
      setData(waiting);
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

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  if (!data && !error) return <LoadingBlock text="正在读取待我处理…" />;

  const items = data?.items ?? [];
  const gmail = data?.origins?.gmail;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            待我处理
            <InfoIcon title="待我处理">
              PMBrain 会展示 Gmail 同步时识别出的待回复和待跟进事项。你可以随时标记完成或忽略。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">把该回的消息和答应过的事放在一起处理。</p>
        </div>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {data?.stale && (
        <div className="pm-card pm-warn">邮件同步有点旧了，下面名单可能不是最新的。请检查 Google 知识源的同步状态。</div>
      )}

      <article className="pm-card daily-card">
        <header>
          <Inbox aria-hidden="true" />
          <div>
            <h2>随 Gmail 同步自动更新</h2>
            <p>这里直接展示同步结果，不会从页面启动实验性扫描。</p>
          </div>
        </header>
        <div className="daily-source-pills">
          <span className={`daily-source-pill${gmail?.ready ? ' is-on' : ''}`}>
            <span>{gmail?.label ?? 'Gmail'}</span>
            <b>{gmail?.ready ? '✅' : '未配置'}</b>
          </span>
        </div>
        <button type="button" className="pm-ghost" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? '正在刷新…' : '刷新结果'}
        </button>
      </article>

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
