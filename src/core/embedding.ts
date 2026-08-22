/**
 * Embedding Service — v0.14+ thin delegation to src/core/ai/gateway.ts.
 *
 * The gateway handles provider resolution, retry, error normalization, and
 * dimension-parameter passthrough (preserving existing 1536-dim brains).
 */

import {
  embed as gatewayEmbed,
  embedOne as gatewayEmbedOne,
  embedQuery as gatewayEmbedQuery,
  getEmbeddingModel as gatewayGetModel,
  getEmbeddingDimensions as gatewayGetDims,
} from './ai/gateway.ts';
import {
  getEmbeddingExecutionProfile,
  isEmbeddingTimeoutError,
  recordEmbeddingExecutionSuccess,
  recordEmbeddingExecutionTimeout,
} from './ai/embedding-execution-profile.ts';

// v0.27.1: re-export multimodal embedding so callers can pull both text and
// image embedding APIs from `src/core/embedding`. import-image-file consumes
// embedMultimodal directly.
//
// v0.36 cross-modal wave: query-side multimodal embedding (text and image
// variants) for hybridSearch routing image-intent queries to the multimodal
// column. embedMultimodalSafe is the partial-failure variant Phase 3 reindex
// uses to make forward progress on transient batch failures.
export {
  embedMultimodal,
  embedMultimodalSafe,
  embedQueryMultimodal,
  embedQueryMultimodalImage,
} from './ai/gateway.ts';
export type {
  MultimodalInput,
  EmbedMultimodalOpts,
  MultimodalBatchResult,
} from './ai/types.ts';

/** Embed one text (document-side for asymmetric providers). */
export async function embed(text: string): Promise<Float32Array> {
  return gatewayEmbedOne(text);
}

/**
 * v0.35.0.0+: embed a single text on the QUERY side. For asymmetric providers
 * (ZE zembed-1, Voyage v3+) this routes `input_type: 'query'` through the
 * embed seam so the provider returns query-side vectors. For symmetric
 * providers (OpenAI text-3, DashScope, Zhipu) the field is dropped — no
 * behavior change. Used by hybrid.ts on the search hot path.
 *
 * v0.36 (D10): optional `embeddingModel` + `dimensions` overrides so the
 * dynamic-embedding-column path can embed via the column's provider rather
 * than the globally-configured default. Bare `embedQuery(text)` preserves
 * pre-v0.36 behavior.
 */
export async function embedQuery(
  text: string,
  opts?: { embeddingModel?: string; dimensions?: number; abortSignal?: AbortSignal },
): Promise<Float32Array> {
  return gatewayEmbedQuery(text, opts);
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each sub-batch completes. CLI wrappers
   * tick a reporter; Minion handlers can call job.updateProgress here.
   */
  onBatchComplete?: (done: number, total: number) => void;
  /**
   * v0.33.4 (D8): propagate the caller's `AbortSignal` into Vercel AI SDK's
   * `embedMany({abortSignal})` so a wall-clock budget can cancel mid-fetch.
   * Without this, a worker stuck mid-HTTP on a ~30s OpenAI timeout ignores
   * the budget until the fetch resolves.
   */
  abortSignal?: AbortSignal;
  /**
   * v0.33.4 (D4a): cap on AI SDK's per-call retries. Default in `embedMany`
   * is 2 (so up to 3 attempts). Pass `0` from higher-level wrappers that
   * own their own retry policy, otherwise wrapper × SDK retries stack
   * (e.g. 3 SDK attempts × 5 wrapper attempts = 15 cycles per embedBatch)
   * and amplify rate-limit pressure.
   */
  maxRetries?: number;
}

/**
 * Embed a batch of texts via the gateway. Hosted providers keep the existing
 * 100-item batches; local recipes can declare a smaller adaptive item profile.
 * Gateway token budgets and retry/error normalization remain unchanged.
 */
export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  if (!texts || texts.length === 0) return [];
  // Build the gateway-call passthrough once; undefined fields stay undefined
  // so non-opt-in callers see unchanged pre-v0.33.4 behavior.
  const gwOpts = {
    ...(options.abortSignal !== undefined && { abortSignal: options.abortSignal }),
    ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
  };
  const model = gatewayGetModel();
  const results: Float32Array[] = [];
  let index = 0;
  while (index < texts.length) {
    const profile = getEmbeddingExecutionProfile(model);
    const slice = texts.slice(index, index + profile.batchSize);
    try {
      const out = await gatewayEmbed(slice, gwOpts);
      results.push(...out);
      index += slice.length;
      recordEmbeddingExecutionSuccess(model);
      options.onBatchComplete?.(results.length, texts.length);
    } catch (error) {
      // Caller-owned wall-clock aborts are not provider-health evidence.
      if (!options.abortSignal?.aborted && isEmbeddingTimeoutError(error)) {
        recordEmbeddingExecutionTimeout(model);
      }
      throw error;
    }
  }
  return results;
}

/** Currently-configured embedding model (short form without provider prefix). */
export function getEmbeddingModelName(): string {
  return gatewayGetModel().split(':').slice(1).join(':') || 'text-embedding-3-large';
}

/** Currently-configured embedding dimensions. */
export function getEmbeddingDimensions(): number {
  return gatewayGetDims();
}

// Back-compat exports for tests that imported these from v0.13.
export const EMBEDDING_MODEL = 'text-embedding-3-large';
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * USD cost per 1k tokens for text-embedding-3-large. Used by
 * `gbrain sync --all` cost preview and `reindex-code` to surface
 * expected spend before accepting expensive operations.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
