import { loadConfig, saveConfig, type GBrainConfig } from './config.ts';

export type EmbeddingRebuildStatus = 'paused' | 'running';

export interface EmbeddingRebuildState {
  status: EmbeddingRebuildStatus;
  model: string;
  dimensions: number;
  total: number;
  updated_at: string;
}

function parseState(value: unknown): EmbeddingRebuildState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status !== 'paused' && record.status !== 'running') return null;
  if (typeof record.model !== 'string' || !record.model.trim()) return null;
  const dimensions = Number(record.dimensions);
  const total = Number(record.total);
  if (!Number.isInteger(dimensions) || dimensions <= 0) return null;
  if (!Number.isInteger(total) || total < 0) return null;
  return {
    status: record.status,
    model: record.model.trim(),
    dimensions,
    total,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : new Date().toISOString(),
  };
}

export function readEmbeddingRebuildState(config: GBrainConfig | null = loadConfig()): EmbeddingRebuildState | null {
  return parseState(config?.embedding_rebuild);
}

export function writeEmbeddingRebuildState(state: EmbeddingRebuildState | null): EmbeddingRebuildState | null {
  const config = loadConfig();
  if (!config) return null;
  if (state) config.embedding_rebuild = state;
  else delete config.embedding_rebuild;
  saveConfig(config);
  return state;
}

export function pauseEmbeddingRebuild(input: {
  model: string;
  dimensions: number;
  total: number;
}): EmbeddingRebuildState {
  const state: EmbeddingRebuildState = {
    status: 'paused',
    model: input.model.trim(),
    dimensions: input.dimensions,
    total: input.total,
    updated_at: new Date().toISOString(),
  };
  writeEmbeddingRebuildState(state);
  return state;
}

export function markEmbeddingRebuildRunning(): EmbeddingRebuildState | null {
  const current = readEmbeddingRebuildState();
  if (!current) return null;
  return writeEmbeddingRebuildState({
    ...current,
    status: 'running',
    updated_at: new Date().toISOString(),
  });
}

export function clearEmbeddingRebuildState(): void {
  writeEmbeddingRebuildState(null);
}

export function embeddingRebuildPausesVectorSearch(config: GBrainConfig | null = loadConfig()): boolean {
  return readEmbeddingRebuildState(config)?.status === 'paused';
}
