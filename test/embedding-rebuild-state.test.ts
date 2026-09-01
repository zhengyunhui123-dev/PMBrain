import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  clearEmbeddingRebuildState,
  embeddingRebuildPausesVectorSearch,
  markEmbeddingRebuildRunning,
  pauseEmbeddingRebuild,
  readEmbeddingRebuildState,
} from '../src/core/embedding-rebuild-state.ts';

describe('embedding rebuild state', () => {
  test('paused rebuild blocks vector search until continued', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pmbrain-embed-rebuild-'));
    const configDir = join(home, '.pmbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ engine: 'pglite' }, null, 2)}\n`);
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: undefined }, () => {
      expect(readEmbeddingRebuildState()).toBeNull();
      expect(embeddingRebuildPausesVectorSearch()).toBe(false);
      pauseEmbeddingRebuild({ model: 'ollama:qwen3-embedding:0.6b', dimensions: 1024, total: 25684 });
      expect(readEmbeddingRebuildState()).toMatchObject({
        status: 'paused',
        model: 'ollama:qwen3-embedding:0.6b',
        total: 25684,
      });
      expect(embeddingRebuildPausesVectorSearch()).toBe(true);
      markEmbeddingRebuildRunning();
      expect(readEmbeddingRebuildState()?.status).toBe('running');
      expect(embeddingRebuildPausesVectorSearch()).toBe(false);
      clearEmbeddingRebuildState();
      expect(readEmbeddingRebuildState()).toBeNull();
    });
  });
});
