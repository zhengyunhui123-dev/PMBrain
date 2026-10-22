import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { loadSearchOptimize, enqueueSearchOptimize, completeSearchOptimize, pauseSearchOptimize, enqueueCapturedSearchOptimize } from '../src/product/tasks/search-optimize-store.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

async function fixture(run: (engine: BrainEngine, calls: string[][]) => Promise<void>) {
  const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
  if (database) assertSafeE2eDatabaseUrl(database);
  const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_MODEL', 'PMBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBEDDING_DIMENSIONS'];
  const saved = keys.map(key => process.env[key]);
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-performance-'));
  keys.forEach(key => delete process.env[key]);
  process.env.PMBRAIN_HOME = root;
  process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: database ? 'postgres' : 'pglite', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, model_usage: { embedding_enabled: true, generative_enabled: false } }));
  const engine = database ? new PostgresEngine() : new PGLiteEngine();
  const calls: string[][] = [];
  try {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'isolated-performance-test' } });
    __setEmbedTransportForTests(async ({ values }) => {
      calls.push([...values]);
      return { values, embeddings: values.map(() => Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0)), usage: { tokens: values.length }, warnings: [] };
    });
    await engine.connect(database ? { database_url: database } : {});
    await engine.initSchema();
    if (database) await resetPgliteState(engine as PGLiteEngine);
    await engine.executeRaw('DELETE FROM config WHERE key LIKE $1', ['pmbrain.search_optimize%']);
    await run(engine, calls);
  } finally {
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    resetGateway();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    rmSync(root, { recursive: true, force: true });
  }
}

test('大文档续跑只读取待优化切块，每批有界且不读取整篇正文，第二轮不再调用模型', async () => {
  await fixture(async (engine, calls) => {
    const slug = 'performance-long-document';
    await engine.putPage(slug, { title: '性能夹具', type: 'note', compiled_truth: '资料正文。'.repeat(5000) });
    const vector = new Float32Array(1536); vector[0] = 1;
    await engine.upsertChunks(slug, Array.from({ length: 40 }, (_, index) => ({
      chunk_index: index, chunk_text: `合成资料第 ${index} 段`, chunk_source: 'compiled_truth' as const,
      ...(index < 20 ? { embedding: vector, model: 'openai:text-embedding-3-large' } : {}),
    })));
    const read = engine.getChunks.bind(engine);
    const page = engine.getPage.bind(engine);
    const sizes: number[] = [];
    let bodies = 0;
    engine.getChunks = async (...args) => { const rows = await read(...args); sizes.push(rows.length); return rows; };
    engine.getPage = async (...args) => { bodies++; return page(...args); };
    const result = await runEmbedCore(engine, { slug, batchSize: 4, providerBatchSize: 4, quiet: true });
    expect(result.embedded).toBe(20);
    expect(result.skipped).toBe(20);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(20);
    expect(bodies).toBe(0);
    expect(calls.flat()).toHaveLength(20);
    expect((await read(slug)).every(chunk => !!chunk.embedded_at)).toBe(true);
    const before = calls.length;
    const second = await runEmbedCore(engine, { slug, batchSize: 4, quiet: true });
    expect(second.embedded).toBe(0);
    expect(calls.length).toBe(before);
    console.log('[performance]', JSON.stringify({ case: 'page', pendingChunks: 20, largestRead: Math.max(...sizes), bodyReads: bodies, repeatModelCalls: calls.length - before }));
  });
}, 60000);

test('切块分页同时限制字节量，游标不漏段且保持代码元数据', async () => {
  await fixture(async engine => {
    const slug = 'performance-byte-budget';
    await engine.putPage(slug, { title: '字节夹具', type: 'note', compiled_truth: '测试正文' });
    await engine.upsertChunks(slug, Array.from({ length: 8 }, (_, index) => ({ chunk_index: index, chunk_text: '中'.repeat(1000), chunk_source: 'fenced_code' as const, language: 'typescript', symbol_name: `test${index}` })));
    const seen: number[] = [];
    for (let after = -1; ;) {
      const rows = await engine.getChunks(slug, { limit: 4, afterChunkIndex: after, maxBytes: 6500 });
      if (!rows.length) break;
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(rows.every(row => row.language === 'typescript' && row.embedding === null)).toBe(true);
      seen.push(...rows.map(row => row.chunk_index));
      after = rows.at(-1)!.chunk_index;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
}, 60000);

test('旧版大队列读取下一项时返回固定大小快照，并保留暂停和完成进度', async () => {
  await fixture(async engine => {
    const items = Array.from({ length: 500 }, (_, index) => ({ sourceId: 'default', slug: `queue-${index}`, revision: `revision-${index}` }));
    const legacy = JSON.stringify({ paused: true, done: 7, items, authorized: items.map(item => `default\n${item.slug}`) });
    await engine.setConfig('pmbrain.search_optimize', legacy);
    const state = await loadSearchOptimize(engine);
    expect(state.paused).toBe(true);
    expect(state.done).toBe(7);
    expect(state.items).toHaveLength(1);
    expect(state.pending).toBe(500);
    expect(state.items[0]).toEqual(items[0]);
    expect(JSON.stringify(state).length).toBeLessThan(1000);
    const writes: number[] = [];
    const transaction = engine.transaction.bind(engine);
    engine.transaction = run => transaction(tx => run(new Proxy(tx, { get(target, key) {
      if (key === 'setConfig') return async (key: string, value: string) => { writes.push(value.length); await target.setConfig(key, value); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } })));
    const next = await completeSearchOptimize(engine, 'default', 'queue-0', 'revision-0');
    expect(next.pending).toBe(499);
    expect(next.done).toBe(8);
    expect(next.items[0].slug).toBe('queue-1');
    expect(Math.max(...writes)).toBeLessThan(1000);
    console.log('[performance]', JSON.stringify({ case: 'queue', pending: 500, legacySnapshotBytes: Buffer.byteLength(legacy), snapshotBytes: Buffer.byteLength(JSON.stringify(state)), largestCompletionWriteBytes: Math.max(...writes) }));
  });
}, 60000);

test('小批向量化在压力变化后缩小批次，暂停保留检查点，继续不重做已完成切块', async () => {
  await fixture(async (engine, calls) => {
    const slug = 'performance-pause';
    await engine.putPage(slug, { title: '暂停夹具', type: 'note', compiled_truth: '合成资料' });
    await engine.upsertChunks(slug, Array.from({ length: 12 }, (_, index) => ({ chunk_index: index, chunk_text: `可续跑的资料 ${index}`, chunk_source: 'compiled_truth' as const })));
    const first = await runEmbedCore(engine, { slug, batchSize: 4, providerBatchSize: 4, quiet: true, pauseCheck: () => calls.length > 0 });
    expect(first.incomplete).toBe(true);
    expect(first.embedded).toBe(4);
    expect((await engine.getChunks(slug)).filter(chunk => !!chunk.embedded_at)).toHaveLength(4);
    const second = await runEmbedCore(engine, { slug, batchSize: 4, providerBatchSize: 4, quiet: true, getBatchSize: () => calls.length > 1 ? 2 : 4 });
    expect(second.embedded).toBe(8);
    expect(calls.map(batch => batch.length)).toEqual([4, 4, 2, 2]);
    expect(new Set(calls.flat()).size).toBe(12);
  });
}, 60000);

test('队列迁移中断后可续跑，重复回执不重复计数，手动暂停跨入队保留', async () => {
  await fixture(async engine => {
    const items = Array.from({ length: 40 }, (_, index) => ({ sourceId: 'default', slug: `resume-${index}` }));
    await engine.setConfig('pmbrain.search_optimize', JSON.stringify({ paused: true, done: 3, items, authorized: ['default\nresume-0'] }));
    const transaction = engine.transaction.bind(engine);
    let commits = 0;
    engine.transaction = async run => {
      const result = await transaction(run);
      if (++commits === 2) throw new Error('simulated restart');
      return result;
    };
    await expect(loadSearchOptimize(engine)).rejects.toThrow('simulated restart');
    engine.transaction = transaction;
    expect(await loadSearchOptimize(engine)).toMatchObject({ paused: true, done: 3, pending: 40 });
    await completeSearchOptimize(engine, 'default', 'resume-0');
    expect(await completeSearchOptimize(engine, 'default', 'resume-0')).toMatchObject({ paused: true, done: 4, pending: 39 });
    expect((await enqueueCapturedSearchOptimize(engine, 'default', ['captured-allowed'], ['resume-0'])).pending).toBe(40);
    expect((await enqueueCapturedSearchOptimize(engine, 'another-source', ['captured-denied'], ['resume-0'])).pending).toBe(40);
    expect((await enqueueCapturedSearchOptimize(engine, 'default', ['captured-denied'], ['resume-1'])).pending).toBe(40);
    expect((await enqueueSearchOptimize(engine, 'default', ['new-after-pause', 'new-after-pause'])).paused).toBe(true);
    await pauseSearchOptimize(engine, false);
    expect((await loadSearchOptimize(engine)).paused).toBe(false);
  });
}, 60000);

test('处理期间入队新版本，旧回执不能删掉新版本，同名资料按 Source 隔离', async () => {
  await fixture(async engine => {
    const slug = 'performance-revision';
    await engine.putPage(slug, { title: '修订', type: 'note', compiled_truth: '第一版' });
    const first = await enqueueSearchOptimize(engine, 'default', [slug]);
    await engine.putPage(slug, { title: '修订', type: 'note', compiled_truth: '第二版' });
    const second = await enqueueSearchOptimize(engine, 'default', [slug]);
    expect(second.items[0].revision).not.toBe(first.items[0].revision);
    expect((await completeSearchOptimize(engine, 'default', slug, first.items[0].revision)).pending).toBe(1);
    await enqueueSearchOptimize(engine, 'another-source', [slug]);
    const next = await completeSearchOptimize(engine, 'default', slug, second.items[0].revision);
    expect(next.pending).toBe(1);
    expect(next.items[0].sourceId).toBe('another-source');
  });
}, 60000);
