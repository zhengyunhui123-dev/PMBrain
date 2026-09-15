import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import {
  parsePgliteBtreeIndexError,
  repairPgliteBtreeIndexes,
} from '../src/core/pglite-btree-repair.ts';

describe('PGLite B-tree index repair', () => {
  test('recognizes the parent-key split reported by sync', () => {
    expect(parsePgliteBtreeIndexError(
      'failed to re-find parent key in index "pg_toast_16808_index" for split pages 294/295',
    )).toBe('pg_toast_16808_index');
    expect(parsePgliteBtreeIndexError(
      'heap tid from index tuple (426,19) points past end of heap page line pointer array at offset 20 of block 10 in index "pages_dedup_idx"',
    )).toBe('pages_dedup_idx');
  });

  test('rebuilds only catalog-confirmed indexes and the pages identity index', async () => {
    const sql: string[] = [];
    const engine = {
      kind: 'pglite',
      async executeRaw(statement: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
        sql.push(statement);
        if (statement.includes('FROM pg_class')) {
          if (params?.[0] === 'pages_source_slug_key') {
            return [{ schema_name: 'public', index_name: 'pages_source_slug_key' }];
          }
          return [{
            schema_name: 'pg_toast',
            index_name: 'pg_toast_16808_index',
            target_table: 'pg_toast_16808',
            base_table: 'pages',
          }];
        }
        return [];
      },
    };

    const result = await repairPgliteBtreeIndexes(
      engine,
      'failed to re-find parent key in index "pg_toast_16808_index" for split pages 294/295',
    );

    expect(result.status).toBe('repaired');
    expect(result.rebuilt).toEqual([
      'pg_toast.pg_toast_16808_index',
      'public.pages_source_slug_key',
    ]);
    expect(sql).toContain('REINDEX INDEX "pg_toast"."pg_toast_16808_index"');
    expect(sql).toContain('REINDEX INDEX "public"."pages_source_slug_key"');
    expect(sql.some((statement) => /REINDEX\s+TABLE/i.test(statement))).toBe(false);
  });

  test('does not repair Postgres or an unrecognized error', async () => {
    const engine = {
      kind: 'postgres',
      async executeRaw(): Promise<Record<string, unknown>[]> {
        throw new Error('must not query');
      },
    };
    expect((await repairPgliteBtreeIndexes(engine, 'some error')).status).toBe('not_applicable');
    expect((await repairPgliteBtreeIndexes(engine, 'failed to re-find parent key in index "x" for split pages 1/2')).status).toBe('not_applicable');
  });

  test('fails closed when the named index is absent or ambiguous', async () => {
    const engine = {
      kind: 'pglite',
      async executeRaw(statement: string): Promise<Record<string, unknown>[]> {
        return statement.includes('FROM pg_class') ? [] : [];
      },
    };
    const result = await repairPgliteBtreeIndexes(
      engine,
      'failed to re-find parent key in index "missing_index" for split pages 1/2',
    );
    expect(result.status).toBe('failed');
    expect(result.message).toContain('catalog');
  });

  test('repairs a pages index pointer error and refreshes the page identity index', async () => {
    const rebuilt: string[] = [];
    const engine = {
      kind: 'pglite',
      async executeRaw(statement: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
        if (statement.includes('FROM pg_class')) {
          if (params?.[0] === 'pages_source_slug_key') {
            return [{ schema_name: 'public', index_name: 'pages_source_slug_key', target_table: 'pages' }];
          }
          return [{ schema_name: 'public', index_name: 'pages_dedup_idx', target_table: 'pages' }];
        }
        if (statement.startsWith('REINDEX INDEX')) rebuilt.push(statement);
        return [];
      },
    };
    const result = await repairPgliteBtreeIndexes(
      engine,
      'heap tid from index tuple (426,19) points past end of heap page line pointer array at offset 20 of block 10 in index "pages_dedup_idx"',
    );
    expect(result.status).toBe('repaired');
    expect(rebuilt).toEqual([
      'REINDEX INDEX "public"."pages_dedup_idx"',
      'REINDEX INDEX "public"."pages_source_slug_key"',
    ]);
  });

  test('does not rebuild the page identity index twice when it is the damaged index', async () => {
    const rebuilt: string[] = [];
    const engine = {
      kind: 'pglite',
      async executeRaw(statement: string): Promise<Record<string, unknown>[]> {
        if (statement.includes('FROM pg_class')) {
          return [{ schema_name: 'public', index_name: 'pages_source_slug_key', target_table: 'pages' }];
        }
        if (statement.startsWith('REINDEX INDEX')) rebuilt.push(statement);
        return [];
      },
    };
    const result = await repairPgliteBtreeIndexes(
      engine,
      'heap tid from index tuple (1,1) points past end of heap page line pointer array at offset 1 of block 1 in index "pages_source_slug_key"',
    );
    expect(result.status).toBe('repaired');
    expect(rebuilt).toEqual(['REINDEX INDEX "public"."pages_source_slug_key"']);
  });

  test('runs the catalog-verified repair against a real isolated PGLite database', async () => {
    const db = await PGlite.create();
    try {
      await db.exec(`
        CREATE TABLE pages (
          id bigserial PRIMARY KEY,
          source_id text NOT NULL,
          slug text NOT NULL,
          content_hash text NOT NULL,
          deleted_at timestamptz
        );
        CREATE UNIQUE INDEX pages_source_slug_key ON pages(source_id, slug);
        CREATE UNIQUE INDEX pages_dedup_idx ON pages(source_id, content_hash) WHERE deleted_at IS NULL;
      `);
      const engine = {
        kind: 'pglite',
        async executeRaw(statement: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
          return (await db.query<Record<string, unknown>>(statement, params)).rows;
        },
      };
      const result = await repairPgliteBtreeIndexes(
        engine,
        'heap tid from index tuple (1,1) points past end of heap page line pointer array at offset 2 of block 3 in index "pages_dedup_idx"',
      );
      expect(result.status).toBe('repaired');
      await db.query('INSERT INTO pages(source_id, slug, content_hash) VALUES ($1, $2, $3)', ['default', 'one', 'hash-one']);
      expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pages')).rows[0]?.n).toBe(1);
    } finally {
      await db.close();
    }
  });
});
