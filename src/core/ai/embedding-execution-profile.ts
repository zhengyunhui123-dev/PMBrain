/**
 * Provider-aware execution policy for embedding jobs.
 *
 * Recipe token budgets and gateway retry/error normalization stay in
 * gateway.ts. This module owns the two controls that used to be global:
 * page-level concurrency and per-request item count. Provider-specific
 * decisions come exclusively from recipe data; callers never branch on
 * `provider === 'ollama'`.
 */
import { loadConfig } from '../config.ts';
import { resolveRecipe } from './model-resolver.ts';

const CLOUD_CONCURRENCY = 20;
const CLOUD_BATCH_SIZE = 100;

interface AdaptiveState {
  concurrency: number;
  batchSize: number;
  consecutiveSuccesses: number;
}

export interface EmbeddingExecutionProfile {
  key: string;
  providerId: string;
  modelId: string;
  adaptive: boolean;
  concurrency: number;
  batchSize: number;
  minConcurrency: number;
  maxConcurrency: number;
  minBatchSize: number;
  maxBatchSize: number;
  successWindow: number;
}

export interface EmbeddingExecutionProfileOptions {
  /** Optional upper bound supplied by pacing/operator controls. */
  requestedConcurrency?: number;
}

const adaptiveStates = new Map<string, AdaptiveState>();

function configuredModel(model?: string): string {
  const resolved = model?.trim() || loadConfig()?.embedding_model?.trim();
  if (!resolved) throw new Error('embedding_model is not configured');
  return resolved;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function operatorConcurrencyCap(options?: EmbeddingExecutionProfileOptions): number | undefined {
  return positiveInt(options?.requestedConcurrency)
    ?? positiveInt(process.env.PMBRAIN_EMBED_CONCURRENCY)
    ?? positiveInt(process.env.GBRAIN_EMBED_CONCURRENCY);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getEmbeddingExecutionProfile(
  model?: string,
  options?: EmbeddingExecutionProfileOptions,
): EmbeddingExecutionProfile {
  const modelString = configuredModel(model);
  const { parsed, recipe } = resolveRecipe(modelString);
  const declared = recipe.touchpoints.embedding?.execution_profile;
  const key = `${parsed.providerId}:${parsed.modelId}`;
  const operatorCap = operatorConcurrencyCap(options);

  if (!declared) {
    const concurrency = operatorCap ?? CLOUD_CONCURRENCY;
    return {
      key,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      adaptive: false,
      concurrency,
      batchSize: CLOUD_BATCH_SIZE,
      minConcurrency: concurrency,
      maxConcurrency: concurrency,
      minBatchSize: CLOUD_BATCH_SIZE,
      maxBatchSize: CLOUD_BATCH_SIZE,
      successWindow: Number.MAX_SAFE_INTEGER,
    };
  }

  let state = adaptiveStates.get(key);
  if (!state) {
    state = {
      concurrency: clamp(
        declared.initial_concurrency,
        declared.min_concurrency,
        declared.max_concurrency,
      ),
      batchSize: clamp(
        declared.initial_batch_items,
        declared.min_batch_items,
        declared.max_batch_items,
      ),
      consecutiveSuccesses: 0,
    };
    adaptiveStates.set(key, state);
  }

  return {
    key,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    adaptive: true,
    concurrency: operatorCap ? Math.min(state.concurrency, operatorCap) : state.concurrency,
    batchSize: state.batchSize,
    minConcurrency: declared.min_concurrency,
    maxConcurrency: operatorCap
      ? Math.min(declared.max_concurrency, operatorCap)
      : declared.max_concurrency,
    minBatchSize: declared.min_batch_items,
    maxBatchSize: declared.max_batch_items,
    successWindow: declared.success_window,
  };
}

export function recordEmbeddingExecutionTimeout(model?: string): void {
  const profile = getEmbeddingExecutionProfile(model);
  if (!profile.adaptive) return;
  const state = adaptiveStates.get(profile.key)!;
  state.concurrency = Math.max(profile.minConcurrency, Math.floor(state.concurrency / 2));
  state.batchSize = Math.max(profile.minBatchSize, Math.floor(state.batchSize / 2));
  state.consecutiveSuccesses = 0;
}

export function recordEmbeddingExecutionSuccess(model?: string): void {
  const profile = getEmbeddingExecutionProfile(model);
  if (!profile.adaptive) return;
  const state = adaptiveStates.get(profile.key)!;
  state.consecutiveSuccesses += 1;
  if (state.consecutiveSuccesses < profile.successWindow) return;
  state.concurrency = Math.min(profile.maxConcurrency, state.concurrency + 1);
  state.batchSize = Math.min(profile.maxBatchSize, state.batchSize + 2);
  state.consecutiveSuccesses = 0;
}

/** Detect timeout-shaped errors through gateway/SDK cause wrappers. */
export function isEmbeddingTimeoutError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.name === 'TimeoutError') return true;
      if (/timed?\s*out|timeout|ETIMEDOUT|UND_ERR_(?:CONNECT_)?TIMEOUT/i.test(current.message)) return true;
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === 'object') {
      const value = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
      if (value.name === 'TimeoutError') return true;
      const text = `${String(value.message ?? '')} ${String(value.code ?? '')}`;
      if (/timed?\s*out|timeout|ETIMEDOUT|UND_ERR_(?:CONNECT_)?TIMEOUT/i.test(text)) return true;
      current = value.cause;
      continue;
    }
    if (/timed?\s*out|timeout|ETIMEDOUT/i.test(String(current))) return true;
    break;
  }
  return false;
}

export interface EmbeddingExecutionPoolOptions<T> {
  items: readonly T[];
  model?: string;
  requestedConcurrency?: number;
  signal?: AbortSignal;
  onItem: (item: T, index: number) => Promise<void>;
  onError?: (error: unknown, item: T, index: number) => void | Promise<void>;
}

/**
 * Run work in profile-sized waves. Re-reading the profile between waves makes
 * timeout downshifts effective during the current job without disturbing the
 * stale cursor/checkpoint semantics owned by callers.
 */
export async function runEmbeddingExecutionPool<T>(
  options: EmbeddingExecutionPoolOptions<T>,
): Promise<void> {
  let next = 0;
  while (next < options.items.length && !options.signal?.aborted) {
    const profile = getEmbeddingExecutionProfile(options.model, {
      requestedConcurrency: options.requestedConcurrency,
    });
    const size = Math.max(1, profile.concurrency);
    const start = next;
    const wave = options.items.slice(start, start + size);
    next += wave.length;
    await Promise.all(wave.map(async (item, offset) => {
      const index = start + offset;
      try {
        await options.onItem(item, index);
      } catch (error) {
        await options.onError?.(error, item, index);
      }
    }));
  }
}

/** @internal test seam. */
export function __resetEmbeddingExecutionProfilesForTests(): void {
  adaptiveStates.clear();
}
