import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { NewFact } from '../../src/core/engine.ts';
import {
  getConn,
  getEngine,
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const RUN = hasDatabase();
const describePostgres = RUN ? describe : describe.skip;

type BatchFact = NewFact & { row_num: number; source_markdown_slug: string };

const fact = (rowNum: number, overrides: Partial<BatchFact> = {}): BatchFact => ({
  fact: `Postgres claim ${rowNum}`,
  kind: 'fact',
  entity_slug: 'people/dream-p0',
  visibility: 'world',
  notability: 'medium',
  source: 'dream:extract_facts',
  confidence: 1,
  row_num: rowNum,
  source_markdown_slug: 'people/dream-p0',
  ...overrides,
});

describePostgres('Dream P0 PostgreSQL parity', () => {
  beforeAll(async () => {
    await setupDB();
  });

  afterAll(async () => {
    await teardownDB();
  });

  beforeEach(async () => {
    await getConn().unsafe(`DELETE FROM facts WHERE entity_slug = 'people/dream-p0'`);
  });

  test('atomic replacement preserves CLI and expired audit facts', async () => {
    const engine = getEngine();
    const seeded = await engine.insertFacts([
      fact(1, { fact: 'stale fence fact' }),
      fact(100, { fact: 'CLI fact', source: 'cli:think' }),
      fact(101, { fact: 'expired audit fact' }),
    ], { source_id: 'default' });
    await getConn().unsafe(
      `UPDATE facts SET expired_at = now() WHERE id = $1`,
      [seeded.ids[2]],
    );

    const result = await engine.insertFacts(
      [fact(1, { fact: 'fresh fence fact' })],
      { source_id: 'default' },
      {
        deleteForPageFirst: {
          slug: 'people/dream-p0',
          excludeSourcePrefixes: ['cli:'],
          preserveExpiredLegacy: true,
        },
      },
    );

    expect(result).toMatchObject({ inserted: 1, deleted: 1 });
    const rows = await getConn().unsafe<{ fact: string; source: string; expired_at: Date | null }[]>(
      `SELECT fact, source, expired_at
         FROM facts
        WHERE source_id = 'default' AND entity_slug = 'people/dream-p0'
        ORDER BY row_num`,
    );
    expect(rows.map(row => row.fact)).toEqual([
      'fresh fence fact',
      'CLI fact',
      'expired audit fact',
    ]);
    expect(rows[2]?.expired_at).not.toBeNull();
  });

  test('replacement deletion rolls back when the new batch fails', async () => {
    const engine = getEngine();
    await engine.insertFacts(
      [fact(1, { fact: 'must survive rollback' })],
      { source_id: 'default' },
    );

    await expect(engine.insertFacts(
      [fact(2), fact(2, { fact: 'duplicate row number' })],
      { source_id: 'default' },
      { deleteForPageFirst: { slug: 'people/dream-p0' } },
    )).rejects.toThrow();

    const rows = await getConn().unsafe<{ fact: string }[]>(
      `SELECT fact FROM facts
        WHERE source_id = 'default' AND entity_slug = 'people/dream-p0'`,
    );
    expect(rows.map(row => row.fact)).toEqual(['must survive rollback']);
  });

  test('schema 117 exposes private queue owner and lease columns', async () => {
    const rows = await getConn().unsafe<{ column_name: string }[]>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'minion_jobs'
          AND column_name IN (
            'private_queue_owner_job_id',
            'private_queue_owner_token',
            'private_queue_lease_until'
          )
        ORDER BY column_name`,
    );
    expect(rows.map(row => row.column_name)).toEqual([
      'private_queue_lease_until',
      'private_queue_owner_job_id',
      'private_queue_owner_token',
    ]);
  });
});
