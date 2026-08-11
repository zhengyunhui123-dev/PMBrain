/**
 * Structural regression tests for the provider-aware embedding pool.
 *
 * The old contract pinned embed.ts to runSlidingPool and a single global
 * concurrency value. PMBrain now routes both full and stale embedding through
 * runEmbeddingExecutionPool so cloud throughput stays at 20 while local
 * providers can adapt after timeouts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const EMBED_SOURCE = readFileSync(resolve(REPO_ROOT, 'src/commands/embed.ts'), 'utf8');
const PROFILE_SOURCE = readFileSync(
  resolve(REPO_ROOT, 'src/core/ai/embedding-execution-profile.ts'),
  'utf8',
);

describe('embed.ts provider-aware execution pool', () => {
  test('routes both full and stale embedding through the shared profile pool', () => {
    expect(EMBED_SOURCE).toMatch(
      /import\s*\{\s*runEmbeddingExecutionPool\s*\}\s*from\s*['"]\.\.\/core\/ai\/embedding-execution-profile\.ts['"]/,
    );
    expect(EMBED_SOURCE.match(/runEmbeddingExecutionPool\(/g) ?? []).toHaveLength(2);
    expect(EMBED_SOURCE).not.toContain('runSlidingPool(');
  });

  test('passes the resolved model into both pool call sites', () => {
    const callSites = EMBED_SOURCE.match(
      /runEmbeddingExecutionPool\(\s*\{[\s\S]*?model:\s*embeddingModel[\s\S]*?\}\);/g,
    );
    expect(callSites?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('keeps the stale wall-clock AbortSignal connected to the pool', () => {
    expect(EMBED_SOURCE).toMatch(
      /runEmbeddingExecutionPool\(\s*\{\s*items:\s*keys,[\s\S]*?signal:\s*budgetSignal/,
    );
  });

  test('keeps cloud concurrency 20 and environment overrides in the profile layer', () => {
    expect(PROFILE_SOURCE).toContain('const CLOUD_CONCURRENCY = 20;');
    expect(PROFILE_SOURCE).toContain('process.env.PMBRAIN_EMBED_CONCURRENCY');
    expect(PROFILE_SOURCE).toContain('process.env.GBRAIN_EMBED_CONCURRENCY');
    expect(EMBED_SOURCE).not.toContain('process.env.GBRAIN_EMBED_CONCURRENCY');
  });

  test('failure reporting retains only stable page and key labels', () => {
    expect(EMBED_SOURCE).toMatch(
      /onError:\s*\(error,\s*page\)\s*=>\s*\{[\s\S]*?page\.slug/,
    );
    expect(EMBED_SOURCE).toMatch(
      /onError:\s*\(error,\s*key\)\s*=>\s*\{[\s\S]*?\$\{key\}/,
    );
  });
});
