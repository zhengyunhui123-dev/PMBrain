import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (DATABASE_URL) assertSafeE2eDatabaseUrl(DATABASE_URL);

describe.skipIf(skip)('schema 125-128 additive foundation (Postgres)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('LATEST_VERSION is 128 and migrations 125-128 are SQL-only', () => {
    expect(LATEST_VERSION).toBe(128);
    for (const version of [125, 126, 127, 128]) {
      const migration = MIGRATIONS.find(item => item.version === version);
      expect(migration?.handler).toBeUndefined();
      expect(migration?.sql).not.toMatch(/UPDATE\s+(pages|facts|timeline_entries)\b/i);
    }
  });

  test('event_page_id exists and idx_timeline_dedup stays on raw summary', async () => {
    const columns = await engine.executeRaw<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'timeline_entries'
         AND column_name = 'event_page_id'
    `);
    expect(columns).toHaveLength(1);
    const indexes = await engine.executeRaw<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'timeline_entries' AND indexname = 'idx_timeline_dedup'
    `);
    expect(indexes[0]?.indexdef).toMatch(/page_id,\s*date,\s*summary,\s*source/);
    expect(indexes[0]?.indexdef).not.toMatch(/md5\s*\(/i);
  });

  test('addTimelineEntry still uses the old conflict target', async () => {
    await engine.putPage('people/pg-additive-timeline', {
      type: 'person',
      title: 'PG additive timeline',
      compiled_truth: 'timeline page',
    });
    await engine.addTimelineEntry('people/pg-additive-timeline', {
      date: '2026-09-12',
      summary: 'first meeting',
    });
    await engine.addTimelineEntry('people/pg-additive-timeline', {
      date: '2026-09-12',
      summary: 'first meeting',
    });
    const rows = await engine.getTimeline('people/pg-additive-timeline');
    expect(rows).toHaveLength(1);
  });

  test('identity and loop tables exist empty; facts ontology columns are nullable', async () => {
    const identityCount = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM entity_identities`,
    );
    const loopCount = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM open_loops`,
    );
    expect(identityCount[0]?.count).toBe(0);
    expect(loopCount[0]?.count).toBe(0);
    await engine.executeRaw(`
      INSERT INTO facts (source_id, entity_slug, fact, kind, source)
      VALUES ('default', 'people/pg-additive-timeline', 'plain fact without dimension', 'fact', 'test')
    `);
    const rows = await engine.executeRaw<{ dimension: string | null }>(`
      SELECT dimension FROM facts
       WHERE entity_slug = 'people/pg-additive-timeline'
    `);
    expect(rows[0]?.dimension).toBeNull();
  });

  test('schema 124 upgrade reaches 128 and keeps existing timeline event_page_id NULL', async () => {
    await engine.putPage('people/pg-legacy-timeline', {
      type: 'person',
      title: 'PG legacy timeline',
      compiled_truth: 'legacy',
    });
    await engine.addTimelineEntry('people/pg-legacy-timeline', {
      date: '2026-01-01',
      summary: 'legacy row',
    });
    await engine.setConfig('version', '124');
    await runMigrations(engine);
    expect(await engine.getConfig('version')).toBe('128');
    const rows = await engine.executeRaw<{ event_page_id: number | null }>(`
      SELECT te.event_page_id
        FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
       WHERE p.slug = 'people/pg-legacy-timeline'
    `);
    expect(rows[0]?.event_page_id).toBeNull();
  }, 60_000);
});
