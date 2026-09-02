import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const ACTION_LABEL = '重建搜索索引';
const ACTION_HINT = '只修复搜索索引，知识内容不会被删除。修好后再继续快速维护。';

export function textLooksLikeGinRepairFailure(text: string): boolean {
  return /搜索索引修复失败|搜索索引异常，已停止后续数据库写入|right sibling of GIN page is of different type|GIN page is of different type/.test(text);
}

export function SearchIndexRepairCard({
  forceShow = false,
  compact = false,
}: {
  forceShow?: boolean;
  compact?: boolean;
}) {
  const [needed, setNeeded] = useState(forceShow);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(forceShow ? ACTION_HINT : '');
  const [done, setDone] = useState<'ok' | 'fail' | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const health = await api.searchIndexHealth();
      if (health.busy) return;
      if (health.ok) {
        if (!forceShow) setNeeded(false);
        return;
      }
      setNeeded(true);
      setMessage(health.message || ACTION_HINT);
      setDone(health.repairable === false ? 'fail' : null);
    } catch {
      if (forceShow) setNeeded(true);
    }
  }, [forceShow]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  const repair = async () => {
    setBusy(true);
    setDone(null);
    setMessage('搜索索引异常，正在重建。知识内容不会受影响。');
    try {
      const result = await api.repairSearchIndex();
      if (result.status === 'repaired' || result.status === 'ok') {
        setDone('ok');
        setMessage(result.message || '搜索索引修复完成。可以继续快速维护。');
        setNeeded(true);
        return;
      }
      setDone('fail');
      setMessage(result.message || '搜索索引修复失败，无法确认搜索已恢复。');
    } catch (error) {
      setDone('fail');
      setMessage(error instanceof Error ? error.message : '搜索索引修复失败，无法确认搜索已恢复。');
    } finally {
      setBusy(false);
    }
  };

  if (!needed && !forceShow) return null;

  return (
    <section className={`overview-health-card ${done === 'ok' ? 'is-good' : 'is-alert'}`} aria-label="搜索索引修复">
      <div className="overview-panel-head">
        <div>
          <div className="overview-section-eyebrow">SEARCH INDEX</div>
          <h2>{done === 'ok' ? '搜索索引修复完成' : '搜索索引异常'}</h2>
        </div>
        {done !== 'ok' && (
          <button
            type="button"
            className="search-index-repair-action"
            disabled={busy}
            onClick={() => void repair()}
          >
            {busy ? '正在重建…' : ACTION_LABEL}
          </button>
        )}
      </div>
      <p className={done === 'fail' ? 'overview-health-error' : 'overview-health-notice'}>
        {message || ACTION_HINT}
      </p>
      {!compact && done === 'ok' && (
        <p className="overview-health-empty">知识内容没有被删除。可以再跑一次快速维护，补完刚才停住的同步。</p>
      )}
    </section>
  );
}
