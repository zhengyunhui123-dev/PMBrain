import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { embedQueryBounded, makeQueryEmbedDeadline } from '../src/core/search/hybrid.ts';

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('query embedding deadline', () => {
  test('falls back instead of waiting forever when a provider ignores abort', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    __setEmbedTransportForTests((async () => new Promise(() => {})) as never);
    const startedAt = Date.now();
    await expect(embedQueryBounded('stalled query', undefined, makeQueryEmbedDeadline(5)))
      .rejects.toThrow(/query embed deadline/);
    expect(Date.now() - startedAt).toBeLessThan(2_800);
  }, 4_000);
});
