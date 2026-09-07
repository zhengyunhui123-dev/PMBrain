import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as realEmbedding from '../src/core/embedding.ts';

function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async (text: string) => {
    if (String(text).includes('EMBEDFAIL')) throw new Error('mock embed provider failure');
    return fixedEmbedding();
  },
}));

const { hybridSearch, textVectorArmNonEmpty } = await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {

  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-relaxed-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const fixtures: Array<[string, string]> = [
    ['notes/zephyr-report', 'The zephyr turbine survey covered coastal ridge lines and marine anemometry.'],
    ['notes/walrus-log', 'The walrus colony census tracked haul-out counts across the northern shelf.'],
  ];
  const vec = `[${Array.from(fixedEmbedding()).join(',')}]`;
  for (const [slug, truth] of fixtures) {
    await engine.putPage(slug, { type: 'note', title: slug.split('/')[1], compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = $1::vector WHERE page_id = (SELECT id FROM pages WHERE slug = $2)`,
      [vec, slug],
    );
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch {  }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {  }
});

describe('engine tagging (PGLite; Postgres pinned by the engine-parity e2e)', () => {
  test('zero-strict-recall + orFallback → rows returned AND tagged keyword_relaxed', async () => {
    const rows = await engine.searchKeyword('zephyr walrus', { limit: 10, orFallback: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.keyword_relaxed).toBe(true);
  });

  test('strict match → rows NOT tagged (fallback never ran)', async () => {
    const rows = await engine.searchKeyword('zephyr turbine', { limit: 10, orFallback: true });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.keyword_relaxed).toBeUndefined();
  });

  test('no orFallback opt-in → zero-strict-recall stays empty (precision consumers unchanged)', async () => {
    const rows = await engine.searchKeyword('zephyr walrus', { limit: 10 });
    expect(rows).toHaveLength(0);
  });
});

describe('title-arm tagging (PGLite — same fallback class as the keyword arm)', () => {
  test('zero-strict title recall → OR fallback rows tagged; strict title match → untagged', async () => {

    const relaxed = await engine.searchTitles('zephyr walrus', { limit: 10 });
    expect(relaxed.length).toBeGreaterThan(0);
    for (const r of relaxed) expect(r.keyword_relaxed).toBe(true);

    const strict = await engine.searchTitles('zephyr report', { limit: 10 });
    expect(strict.length).toBeGreaterThan(0);
    for (const r of strict) expect(r.keyword_relaxed).toBeUndefined();
  });
});

describe('hybrid fusion demotion', () => {
  test('healthy vector arm → relaxed rows are dropped pre-fusion (no keyword_relaxed row survives)', async () => {

    const relaxed = await engine.searchKeyword('zephyr walrus', { limit: 10, orFallback: true });
    expect(relaxed.length).toBeGreaterThan(0);

    const res = await hybridSearch(engine, 'zephyr walrus', { limit: 10, expansion: false });
    expect(res.length).toBeGreaterThan(0);
    for (const r of res) expect(r.keyword_relaxed).toBeUndefined();
  });

  test('vector arm down (embed failure) → relaxed rows still rescue (fallback path unchanged)', async () => {
    const res = await hybridSearch(engine, 'EMBEDFAIL zephyr walrus', { limit: 10, expansion: false });
    expect(res.length).toBeGreaterThan(0);

    expect(res.some((r) => r.keyword_relaxed === true)).toBe(true);
  });

  test('muted relaxed rows report their count while the vector arm remains enabled', async () => {
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const res = await hybridSearch(engine, 'zephyr walrus', {
      limit: 10,
      expansion: false,
      onMeta: (m) => { meta = m; },
    });
    expect(res.length).toBeGreaterThan(0);
    expect(meta?.relaxed_dropped ?? 0).toBeGreaterThan(0);

    expect(meta?.vector_enabled).toBe(true);
  });
});

describe('textVectorArmNonEmpty (pure demotion gate — red-team both-mode finding)', () => {
  const row = (slug: string) => ({ slug, chunk_text: slug, score: 1 }) as never;
  test('both mode: a nonempty IMAGE branch alone must NOT mute the lexical rescue (text lists all empty)', () => {

    expect(textVectorArmNonEmpty([[], [row('img/photo')]], true)).toBe(false);
  });
  test('both mode: any nonempty TEXT list counts as healthy (image branch irrelevant)', () => {
    expect(textVectorArmNonEmpty([[row('notes/a')], []], true)).toBe(true);
    expect(textVectorArmNonEmpty([[], [row('notes/b')], []], true)).toBe(true);
  });
  test('text mode: gate reads every list (no image branch to exclude)', () => {
    expect(textVectorArmNonEmpty([[]], false)).toBe(false);
    expect(textVectorArmNonEmpty([[], [row('notes/a')]], false)).toBe(true);
  });
});
