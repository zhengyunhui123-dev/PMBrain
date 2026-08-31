import { AsyncLocalStorage } from 'node:async_hooks';
import { estimateMaxCostUsd } from '../anthropic-pricing.ts';

export interface ChatUsageRecord {
  model: string;
  provider: string | null;
  phase: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
}

export type ChatUsageSink = (record: ChatUsageRecord) => void | Promise<void>;
const phaseStore = new AsyncLocalStorage<string>();
let sinks: ChatUsageSink[] = [];

export function withChatPhase<T>(phase: string, fn: () => T): T {
  return phaseStore.run(phase, fn);
}

export function registerChatUsageSink(sink: ChatUsageSink): () => void {
  sinks.push(sink);
  return () => { sinks = sinks.filter((candidate) => candidate !== sink); };
}

export function setChatUsageSink(sink: ChatUsageSink | null): void {
  sinks = sink ? [sink] : [];
}

export function estimateChatCostUsd(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}): number | null {
  // The local pricing table has one input rate. Treat cache tokens as input
  // until a provider publishes distinct rates; unknown models stay NULL.
  return estimateMaxCostUsd(
    model,
    usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0),
    usage.output_tokens,
  );
}

export function recordChatUsage(input: {
  model: string;
  provider?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}): void {
  const sink = sinks.at(-1);
  if (!sink) return;
  const record: ChatUsageRecord = {
    model: input.model,
    provider: input.provider ?? null,
    phase: phaseStore.getStore() ?? null,
    input_tokens: Math.max(0, Math.round(input.usage.input_tokens || 0)),
    output_tokens: Math.max(0, Math.round(input.usage.output_tokens || 0)),
    cache_read_tokens: Math.max(0, Math.round(input.usage.cache_read_tokens || 0)),
    cache_write_tokens: Math.max(0, Math.round(input.usage.cache_write_tokens || 0)),
    cost_usd: estimateChatCostUsd(input.model, input.usage),
  };
  try { void Promise.resolve(sink(record)).catch(() => undefined); } catch { /* fail open */ }
}

export function makeEngineChatUsageSink(engine: {
  executeRaw: (sql: string, params?: unknown[]) => Promise<unknown>;
}): ChatUsageSink {
  return async (record) => {
    await engine.executeRaw(
      `INSERT INTO chat_usage_log
       (model, provider, phase, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.model, record.provider, record.phase, record.input_tokens,
        record.output_tokens, record.cache_read_tokens,
        record.cache_write_tokens, record.cost_usd,
      ],
    );
  };
}
