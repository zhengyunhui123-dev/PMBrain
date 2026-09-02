import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configCommand = readFileSync(resolve('src/commands/config.ts'), 'utf8');
const cycle = readFileSync(resolve('src/core/cycle.ts'), 'utf8');

describe('embedding model switch contract', () => {
  test('CLI validates before invalidation, rebuilds immediately, and only rolls back before commit', () => {
    const validateAt = configCommand.indexOf('detectEmbeddingDimensions(nextModel, provisionalDimensions)');
    const saveAt = configCommand.indexOf('saveConfig(candidate)');
    const invalidateAt = configCommand.indexOf('forceReembed: Boolean(previousModel)');
    const rebuildAt = configCommand.indexOf(
      'runEmbedCore(engine, { stale: true, catchUp: true })',
      invalidateAt,
    );

    expect(validateAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(validateAt);
    expect(invalidateAt).toBeGreaterThan(saveAt);
    expect(rebuildAt).toBeGreaterThan(invalidateAt);
    expect(configCommand).toContain('if (!committed)');
    expect(configCommand).toContain('saveConfig(current)');
  });

  test('default Dream cycles only fill missing vectors and never invalidate a model implicitly', () => {
    expect(cycle).toMatch(/export const ALL_PHASES[\s\S]*?'embed'/);
    expect(cycle).toMatch(
      /runEmbedCore\(engine,\s*\{\s*stale:\s*true,\s*dryRun,\s*sourceId,[\s\S]*?\}\);/,
    );
    const embed = readFileSync(resolve('src/commands/embed.ts'), 'utf8');
    expect(embed).toContain('preflightEmbeddingModelChange(engine, !!opts.dryRun)');
    expect(embed).toMatch(/FROM content_chunks c\s+JOIN pages p ON p\.id = c\.page_id\s+WHERE c\.embedding IS NOT NULL\s+AND p\.deleted_at IS NULL/);
    expect(embed).not.toContain('invalidateMismatchedEmbeddingModels(engine, getEmbeddingModel())');
    expect(embed).toContain('Dream、同步或普通向量补全时自动清空已有向量');
  });

  test('both database engines exclude soft-deleted pages from stale embedding queries', () => {
    for (const path of ['src/core/postgres-engine.ts', 'src/core/pglite-engine.ts']) {
      const source = readFileSync(resolve(path), 'utf8');
      const staleQueries = source.match(
        /WHERE \(cc\.embedding IS NULL OR \(cc\.embedded_text_hash IS NOT NULL AND cc\.embedded_text_hash <> md5\(cc\.chunk_text\)\)\)\s+AND p\.deleted_at IS NULL/g,
      ) ?? [];
      expect(staleQueries.length).toBe(8);
    }
  });
});
