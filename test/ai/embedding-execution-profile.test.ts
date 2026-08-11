/**
 * Provider-aware embedding execution tests.
 *
 * Product-level intent:
 * - hosted providers keep the existing 20-page / 100-chunk throughput;
 * - Ollama starts conservatively, backs off after a timeout, and recovers only
 *   after a sustained successful run;
 * - provider branching lives in the profile layer, not in import/embed callers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetEmbeddingExecutionProfilesForTests,
  getEmbeddingExecutionProfile,
  recordEmbeddingExecutionSuccess,
  recordEmbeddingExecutionTimeout,
  runEmbeddingExecutionPool,
} from '../../src/core/ai/embedding-execution-profile.ts';

describe('getEmbeddingExecutionProfile', () => {
  beforeEach(() => {
    __resetEmbeddingExecutionProfilesForTests();
    delete process.env.PMBRAIN_EMBED_CONCURRENCY;
    delete process.env.GBRAIN_EMBED_CONCURRENCY;
  });

  afterEach(() => {
    delete process.env.PMBRAIN_EMBED_CONCURRENCY;
    delete process.env.GBRAIN_EMBED_CONCURRENCY;
    __resetEmbeddingExecutionProfilesForTests();
  });

  test('hosted providers retain the existing cloud throughput defaults', () => {
    const openai = getEmbeddingExecutionProfile('openai:text-embedding-3-large');
    const zhipu = getEmbeddingExecutionProfile('zhipu:embedding-3');

    expect(openai.concurrency).toBe(20);
    expect(openai.batchSize).toBe(100);
    expect(openai.adaptive).toBe(false);
    expect(zhipu.concurrency).toBe(20);
    expect(zhipu.batchSize).toBe(100);
  });

  test('Ollama starts with a bounded local profile and honors a lower operator cap', () => {
    const initial = getEmbeddingExecutionProfile('ollama:qwen3-embedding:0.6b');
    expect(initial.concurrency).toBe(2);
    expect(initial.batchSize).toBe(12);
    expect(initial.adaptive).toBe(true);

    process.env.GBRAIN_EMBED_CONCURRENCY = '1';
    const capped = getEmbeddingExecutionProfile('ollama:qwen3-embedding:0.6b');
    expect(capped.concurrency).toBe(1);
  });

  test('timeout reduces Ollama concurrency and batch size, sustained success heals them', () => {
    const model = 'ollama:qwen3-embedding:0.6b';
    recordEmbeddingExecutionTimeout(model);

    const reduced = getEmbeddingExecutionProfile(model);
    expect(reduced.concurrency).toBe(1);
    expect(reduced.batchSize).toBe(8);

    for (let i = 0; i < 8; i++) recordEmbeddingExecutionSuccess(model);
    const healed = getEmbeddingExecutionProfile(model);
    expect(healed.concurrency).toBe(2);
    expect(healed.batchSize).toBe(10);
  });

  test('dynamic pool applies a timeout downshift to later work in the same run', async () => {
    const model = 'ollama:qwen3-embedding:0.6b';
    let active = 0;
    let maxAfterTimeout = 0;
    let timedOut = false;

    await runEmbeddingExecutionPool({
      items: [0, 1, 2, 3, 4, 5],
      model,
      onItem: async (item) => {
        active++;
        // Items 0-1 were already claimed in the initial concurrency=2 wave.
        // Only later items prove that the next wave observed the downshift.
        if (timedOut && item >= 2) maxAfterTimeout = Math.max(maxAfterTimeout, active);
        if (item === 0) {
          recordEmbeddingExecutionTimeout(model);
          timedOut = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
      },
    });

    expect(maxAfterTimeout).toBe(1);
  });
});
