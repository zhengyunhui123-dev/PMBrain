/**
 * Isolated gateway integration checks for provider-aware item batching.
 * Kept serial because other embedding command tests replace embedding.ts with
 * a module mock, while these assertions need the real gateway delegation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetEmbeddingExecutionProfilesForTests,
  getEmbeddingExecutionProfile,
} from '../src/core/ai/embedding-execution-profile.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { embedBatch } from '../src/core/embedding.ts';

describe('embedBatch provider-aware item batching', () => {
  beforeEach(() => {
    resetGateway();
    __resetEmbeddingExecutionProfilesForTests();
  });

  afterEach(() => {
    __setEmbedTransportForTests(null);
    resetGateway();
    __resetEmbeddingExecutionProfilesForTests();
  });

  test('cloud path still sends batches of 100', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    const lengths: number[] = [];
    __setEmbedTransportForTests(async ({ values }) => {
      lengths.push(values.length);
      return { embeddings: values.map(() => Array(1536).fill(0)) } as any;
    });

    const result = await embedBatch(Array.from({ length: 205 }, (_, i) => `cloud-${i}`));
    expect(result).toHaveLength(205);
    expect(lengths).toEqual([100, 100, 5]);
  });

  test('Ollama timeout downshifts the next request to batches of 8', async () => {
    configureGateway({
      embedding_model: 'ollama:qwen3-embedding:0.6b',
      embedding_dimensions: 1024,
      env: {},
    });
    __setEmbedTransportForTests(async () => {
      const error = new Error('Ollama request timed out');
      error.name = 'TimeoutError';
      throw error;
    });

    await expect(embedBatch(Array.from({ length: 20 }, (_, i) => `local-${i}`))).rejects.toThrow();
    expect(getEmbeddingExecutionProfile('ollama:qwen3-embedding:0.6b').batchSize).toBe(8);

    const lengths: number[] = [];
    __setEmbedTransportForTests(async ({ values }) => {
      lengths.push(values.length);
      return { embeddings: values.map(() => Array(1024).fill(0)) } as any;
    });
    const result = await embedBatch(Array.from({ length: 20 }, (_, i) => `local-retry-${i}`));
    expect(result).toHaveLength(20);
    expect(lengths).toEqual([8, 8, 4]);
  });
});
