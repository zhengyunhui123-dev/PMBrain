import { afterAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getPGLiteSchema } from '../src/core/pglite-schema.ts';
import {
  applyExistingColumnHnswPolicy,
  isHnswDimensionLimitError,
  PGVECTOR_HNSW_VECTOR_MAX_DIMS,
} from '../src/core/vector-index.ts';

describe('HNSW upgrade guard for existing wide vector columns', () => {
  test('strips chunk HNSW from a 1280-dim schema replay when the live column is 2048', () => {
    const replayed = applyExistingColumnHnswPolicy(getPGLiteSchema(1280), 2048);
    expect(replayed).toMatch(/vector\(1280\)/);
    expect(replayed).not.toContain('idx_chunks_embedding ON content_chunks USING hnsw');
    expect(replayed).toContain('exact vector scans remain available');
  });

  test('keeps HNSW when the live column is within the pgvector cap', () => {
    const replayed = applyExistingColumnHnswPolicy(getPGLiteSchema(1280), 1024);
    expect(replayed).toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('recognizes the pgvector HNSW dimension hard-limit error', () => {
    expect(isHnswDimensionLimitError(new Error('column cannot have more than 2000 dimensions for hnsw index'))).toBe(true);
    expect(isHnswDimensionLimitError(new Error('column cannot have more than 4000 dimensions for hnsw index'))).toBe(true);
    expect(isHnswDimensionLimitError(new Error('relation already exists'))).toBe(false);
  });
});

describe('PGLite schema replay against an existing vector(2048) brain', () => {
  const engines: PGLiteEngine[] = [];

  afterAll(async () => {
    for (const engine of engines) await engine.disconnect();
  }, 60_000);

  test('creating HNSW on vector(2048) throws; policy-stripped replay does not', async () => {
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({} as never);
    await engine.db.exec(getPGLiteSchema(2048));

    let thrown: unknown;
    try {
      await engine.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);',
      );
    } catch (error) {
      thrown = error;
    }
    expect(isHnswDimensionLimitError(thrown)).toBe(true);

    await engine.db.exec(applyExistingColumnHnswPolicy(getPGLiteSchema(1280), 2048));
    const indexes = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'`,
    );
    expect(indexes).toEqual([]);
  }, 60_000);

  test('initSchema upgrades a vector(2048) brain without aborting on HNSW', async () => {
    const engine = new PGLiteEngine();
    engines.push(engine);
    await engine.connect({} as never);
    await engine.db.exec(getPGLiteSchema(2048));
    await engine.initSchema();
    const indexes = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'`,
    );
    expect(indexes).toEqual([]);
  }, 180_000);
});
