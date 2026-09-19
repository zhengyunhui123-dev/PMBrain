import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LATEST_VERSION, MIGRATIONS } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

delete process.env.GBRAIN_PGLITE_SNAPSHOT;

let engine: PGLiteEngine;

describe('schema 129-130 chronicle timeline repair', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('LATEST_VERSION is 130', () => {
    expect(LATEST_VERSION).toBe(130);
    expect(MIGRATIONS.find(m => m.version === 129)?.name).toBe('timeline_dedup_md5_summary');
    expect(MIGRATIONS.find(m => m.version === 130)?.name).toBe('timeline_legacy_source_split_repair');
  });

  test('long summary timeline insert does not overflow btree', async () => {
    await engine.putPage('people/long-summary', {
      type: 'person',
      title: 'Long summary',
      compiled_truth: 'body',
    });
    const summary = 'x'.repeat(4000);
    await engine.addTimelineEntry('people/long-summary', {
      date: '2026-09-12',
      summary,
      source: 'meetings/long.md',
    });
    const rows = await engine.getTimeline('people/long-summary');
    expect(rows[0]?.summary.length).toBe(4000);
  });
});
