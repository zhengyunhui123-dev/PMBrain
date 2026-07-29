import { describe, test, expect } from 'bun:test';
import { getPGLiteSchema, PGLITE_SCHEMA_SQL } from '../../src/core/pglite-schema.ts';
import { getPostgresSchema } from '../../src/core/postgres-engine.ts';

describe('getPGLiteSchema', () => {
  test('default creates storage width without activating an embedding model', () => {
    const sql = getPGLiteSchema();
    expect(sql).toMatch(/vector\(1280\)/);
    expect(sql).not.toMatch(/\('embedding_model',/);
    expect(sql).toMatch(/model\s+TEXT,/);
    expect(sql).not.toMatch(/__EMBEDDING_DIMS__/);
    expect(sql).not.toMatch(/__EMBEDDING_MODEL__/);
  });

  test('Gemini 768d substitution', () => {
    const sql = getPGLiteSchema(768, 'gemini-embedding-001');
    expect(sql).toMatch(/vector\(768\)/);
    expect(sql).not.toMatch(/'gemini-embedding-001'/);
    expect(sql).not.toMatch(/\('embedding_model',/);
    expect(sql).toMatch(/\('embedding_dimensions', '768'\)/);
    expect(sql).not.toMatch(/vector\(1536\)/);
  });

  test('Voyage 1024d substitution', () => {
    const sql = getPGLiteSchema(1024, 'voyage-3-large');
    expect(sql).toMatch(/vector\(1024\)/);
    expect(sql).not.toMatch(/'voyage-3-large'/);
    expect(sql).not.toMatch(/\('embedding_model',/);
    expect(sql).toMatch(/\('embedding_dimensions', '1024'\)/);
    expect(sql).toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('Voyage 2048d skips unsupported HNSW index but keeps vector column', () => {
    const sql = getPGLiteSchema(2048, 'voyage-4-large');
    expect(sql).toMatch(/vector\(2048\)/);
    expect(sql).not.toMatch(/'voyage-4-large'/);
    expect(sql).toMatch(/\('embedding_dimensions', '2048'\)/);
    expect(sql).not.toContain('idx_chunks_embedding ON content_chunks USING hnsw');
    expect(sql).toContain('exact vector scans remain available');
  });

  test('PGLITE_SCHEMA_SQL back-compat constant is the default-dim schema', () => {
    expect(PGLITE_SCHEMA_SQL).toBe(getPGLiteSchema());
  });
});

describe('getPostgresSchema', () => {
  test('Voyage 2048d updates storage width without seeding a provider', () => {
    const sql = getPostgresSchema(2048, 'voyage-4-large');
    expect(sql).toMatch(/vector\(2048\)/);
    expect(sql).not.toMatch(/\('embedding_model',/);
    expect(sql).toMatch(/\('embedding_dimensions', '2048'\)/);
    expect(sql).not.toContain('idx_chunks_embedding ON content_chunks USING hnsw');
  });

  test('does not insert a configured model into fresh schema SQL', () => {
    const sql = getPostgresSchema(1024, "voyage-weird'quoted");
    expect(sql).not.toContain('voyage-weird');
  });
});
