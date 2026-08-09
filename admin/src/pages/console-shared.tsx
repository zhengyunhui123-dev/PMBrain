import React, { useCallback, useEffect, useState } from 'react';
import { api, isPgliteBusyError } from '../api';

export interface SourceSummary {
  id: string;
  name: string;
  local_path: string | null;
  git_repo: boolean;
  federated: boolean;
  page_count: number;
  last_sync_at: string | null;
  archived?: boolean;
  archived_at?: string | null;
  archive_expires_at?: string | null;
}

export interface BrainOverview {
  version: string;
  engine: string;
  schema_pack: string;
  chat_model: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  expansion_model: string | null;
  stats: {
    page_count: number;
    chunk_count: number;
    embedded_count: number;
    link_count: number;
    tag_count: number;
    timeline_entry_count: number;
    pages_by_type: Record<string, number>;
  };
  embedding_coverage: number;
  pending_embeddings: number;
  recent_write_at: string | null;
  sources: SourceSummary[];
  main_source_id: string;
  federated_source_count: number;
  provider_status: {
    providers: Record<string, boolean>;
    chat: { enabled: boolean; chat_model: string | null; provider: string | null; missing: string[] };
  };
  llm_enabled: boolean;
  config: Record<string, unknown>;
}

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
      setOverview(await api.brainOverview() as BrainOverview);
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
