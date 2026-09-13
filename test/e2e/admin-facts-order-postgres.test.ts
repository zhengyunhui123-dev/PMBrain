import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { listAdminBrainFacts } from '../../src/commands/admin-console.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('Admin facts update ordering PostgreSQL parity', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 60_000);
  afterAll(async () => { await teardownDB(); });

  test('orders by displayed update time and uses id for equal timestamps', async () => {
    for (const [fact, created, embedded] of [
      ['old-updated', '2026-01-01', '2026-09-13'],
      ['new-unembedded', '2026-09-12', null],
      ['same-update', '2026-02-01', '2026-09-13'],
    ]) {
      await engine.executeRaw(
        `INSERT INTO facts (fact, source, created_at, embedded_at) VALUES ($1, 'sort-test', $2::timestamptz, $3::timestamptz)`,
        [fact, created, embedded],
      );
    }
    const listed = await listAdminBrainFacts(engine, {});
    expect(listed.rows.map(row => row.fact)).toEqual(['same-update', 'old-updated', 'new-unembedded']);
  });
});
