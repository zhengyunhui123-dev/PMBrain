import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { DELETE_BATCH_SIZE } from '../src/core/engine-constants.ts';
import { createProgress } from '../src/core/progress.ts';
import { runPhaseRecomputeEmotionalWeight } from '../src/core/cycle/recompute-emotional-weight.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function sink(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (c) => chunks.push(c.toString('utf8')));
  return { stream, read: () => chunks.join('') };
}

function parseJsonl(raw: string): Record<string, unknown>[] {
  return raw
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('recompute_emotional_weight load/write progress and batching', () => {
  test('emits load and write start/finish and chunks writes at DELETE_BATCH_SIZE', async () => {
    const { stream, read } = sink();
    const progress = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    const writeSizes: number[] = [];
    const pageCount = DELETE_BATCH_SIZE + 17;
    const engine = {
      getConfig: async () => null,
      batchLoadEmotionalInputs: async () => Array.from({ length: pageCount }, (_, i) => ({
        slug: `notes/p-${i}`,
        source_id: 'default',
        tags: [] as string[],
        takes: [] as Array<{ holder: string; weight: number; kind: string; active: boolean }>,
      })),
      setEmotionalWeightBatch: async (rows: Array<{ slug: string }>) => {
        writeSizes.push(rows.length);
        return rows.length;
      },
    };

    const result = await runPhaseRecomputeEmotionalWeight(engine as never, { progress });
    expect(result.status).toBe('ok');
    expect(result.pages_recomputed).toBe(pageCount);
    expect(writeSizes).toEqual([DELETE_BATCH_SIZE, 17]);

    const events = parseJsonl(read());
    const loadStart = events.find(e => e.event === 'start' && e.phase === 'recompute_emotional_weight.load');
    const loadFinish = events.find(e => e.event === 'finish' && e.phase === 'recompute_emotional_weight.load');
    const writeStart = events.find(e => e.event === 'start' && e.phase === 'recompute_emotional_weight.write');
    const writeFinish = events.find(e => e.event === 'finish' && e.phase === 'recompute_emotional_weight.write');
    expect(loadStart).toBeDefined();
    expect(loadFinish).toBeDefined();
    expect(writeStart?.total).toBe(pageCount);
    expect(writeFinish).toBeDefined();
    expect(events.findIndex(e => e === loadStart)).toBeLessThan(events.findIndex(e => e === loadFinish));
    expect(events.findIndex(e => e === loadFinish)).toBeLessThan(events.findIndex(e => e === writeStart));
  });

  test('PGLite and Postgres load queries constrain tags/takes to target pages', async () => {
    const pglite = await Bun.file(new URL('../src/core/pglite-engine.ts', import.meta.url)).text();
    const postgres = await Bun.file(new URL('../src/core/postgres-engine.ts', import.meta.url)).text();
    for (const source of [pglite, postgres]) {
      expect(source).toContain('target_pages');
      expect(source).toContain('INNER JOIN target_pages');
      expect(source).not.toMatch(/FROM tags GROUP BY page_id/);
      expect(source).not.toMatch(/FROM takes WHERE active = TRUE GROUP BY page_id/);
    }
  });
});

describe('recompute_emotional_weight PGLite source-scoped load', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('other', 'Other', NULL, '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
    );
    await engine.putPage('notes/shared', { type: 'note', title: 'Default', compiled_truth: 'default page' }, { sourceId: 'default' });
    await engine.putPage('notes/shared', { type: 'note', title: 'Other', compiled_truth: 'other page' }, { sourceId: 'other' });
    await engine.addTag('notes/shared', 'wedding', { sourceId: 'default' });
    await engine.addTag('notes/shared', 'work', { sourceId: 'other' });
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('sourceId load does not pull the other Source page', async () => {
    const rows = await engine.batchLoadEmotionalInputs(undefined, { sourceId: 'default' });
    const shared = rows.filter(row => row.slug === 'notes/shared');
    expect(shared).toEqual([
      expect.objectContaining({ source_id: 'default', tags: ['wedding'] }),
    ]);
  });
});
