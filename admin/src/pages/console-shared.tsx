import React, { useCallback, useEffect, useState } from 'react';
import { api, isPgliteBusyError } from '../api';
import type {
  BrainOverviewResponse as BrainOverview,
  SourceSummary,
} from '../../../shared/contracts/brain.ts';

export type { BrainOverview, SourceSummary };

export function pct(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : '0'}%`;
}

export function MetricCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="pm-card pm-metric">
      <div className="pm-muted">{label}</div>
      <div className="pm-metric-value">{value}</div>
      {hint && <div className="pm-hint">{hint}</div>}
    </div>
  );
}

export function LoadingBlock({ text = '正在读取 PMBrain 状态...' }: { text?: string }) {
  return <div className="pm-card pm-empty">{text}</div>;
}

export function useOverview() {
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [error, setError] = useState('');
  const [pgliteBusy, setPgliteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await api.brainOverview());
      setError('');
      setPgliteBusy(false);
    } catch (error) {
      setPgliteBusy(isPgliteBusyError(error));
      setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { overview, error, pgliteBusy, reload: load };
}

export function sourceLabel(source?: SourceSummary): string {
  if (!source) return 'default';
  return source.name && source.name !== source.id ? `${source.name} (${source.id})` : source.id;
}
