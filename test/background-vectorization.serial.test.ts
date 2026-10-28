import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { PGLiteEngine } from '../src/core/pglite-engine';
import { resetPgliteState } from './helpers/reset-pglite';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { LATEST_VERSION } from '../src/core/migrate';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';
import { configPath } from '../src/core/config';
import { reloadLiveGateway } from '../src/core/ai/reload-live-gateway';
import { resetGateway } from '../src/core/ai/gateway';
import type { BrainEngine } from '../src/core/engine';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(40);
  }
  throw new Error(label);
}

async function fixture(run: (ctx: {
  engine: BrainEngine; runtime: ProductTaskRuntime; directory: string; calls: string[][];
  state: { cpu: number; now: number; delay?: Promise<void>; onRequest?: () => void; fail?: boolean };
  restart: () => Promise<void>;
}) => Promise<void>) {
  const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
  if (database) assertSafeE2eDatabaseUrl(database);
  const dimensions = database ? 1536 : 1024;
  const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_TASK_TEST_DATABASE_URL', 'PMBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_MODEL', 'PMBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBEDDING_DIMENSIONS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-background-vectors-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root;
  process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  const directory = join(root, 'materials');
  mkdirSync(directory);
  const calls: string[][] = [];
  const state: { cpu: number; now: number; delay?: Promise<void>; onRequest?: () => void; fail?: boolean } = { cpu: 0.1, now: Date.now() };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json() as { input: string[] | string };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    calls.push(inputs);
    state.onRequest?.();
    await state.delay;
    if (state.fail) return Response.json({ error: { message: 'temporary unavailable' } }, { status: 503 });
    return Response.json({ data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })), model: 'background-test', usage: { prompt_tokens: inputs.length, total_tokens: inputs.length } });
  } });
  writeFileSync(configPath(), JSON.stringify({
    engine: database ? 'postgres' : 'pglite', ...(database ? { database_url: database } : { database_path: join(root, 'database') }), embedding_model: 'custom-openai:background-test', embedding_dimensions: dimensions,
    custom_openai_api_key: 'isolated-background-only', provider_base_urls: { 'custom-openai': server.url.origin + '/v1' },
    model_usage: { embedding_enabled: true, generative_enabled: false }, desktop: { knowledge_directory: root },
  }));
  const engine = (database ? new PostgresEngine() : new WorkerPgliteEngine()) as unknown as BrainEngine;
  const options = { background: { now: () => state.now, sample: () => ({ cpuBusyRatio: state.cpu, bytes: 1024 ** 3, availableBytes: 12 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, systemIdleSeconds: 120 }) } };
  let runtime: ProductTaskRuntime | undefined;
  try {
    await engine.connect(database ? { database_url: database } : { database_path: join(root, 'database') });
    await engine.initSchema();
    if (database) {
      await resetPgliteState(engine as PGLiteEngine);
      await engine.setConfig('version', String(LATEST_VERSION));
      await engine.setConfig('pmbrain.schema.version', String(LATEST_VERSION));
    }
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [directory, 'default']);
    await engine.setConfig('dream.entity_capture.enabled', 'false');
    await reloadLiveGateway(engine);
    runtime = new ProductTaskRuntime(engine, options);
    await runtime.start();
    const ctx = { engine, runtime, directory, calls, state, restart: async () => {
      await runtime!.close();
      runtime = new ProductTaskRuntime(engine, options);
      ctx.runtime = runtime;
      await runtime.start();
    } };
    await run(ctx);
  } finally {
    server.stop(true);
    await runtime?.close();
    await engine.disconnect();
    resetGateway();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    rmSync(root, { recursive: true, force: true });
  }
}

test('忙时导入先成功，空闲才向量化；慢模型请求不占用数据库或阻塞下一次导入', async () => {
  await fixture(async ({ engine, runtime, directory, calls, state }) => {
    state.cpu = 0.95;
    const path = join(directory, 'first.md');
    writeFileSync(path, '# 第一份\n\n原始资料内容需要保留。');
    const first = await runtime.submitImport({ path });
    const imported = await until(() => runtime.getRun(first.id), row => row?.status === 'completed', '导入未先成功');
    expect(imported!.result).toMatchObject({ searchOptimizeAccepted: true });
    const queued = await until(() => runtime.listRuns(), rows => rows.some(row => row.searchOptimize && row.product?.background?.mode === 'waiting'), '没有等待空闲状态');
    const vectorTask = queued.find(row => row.searchOptimize)!;
    expect(vectorTask.status).toBe('queued');
    expect(calls).toHaveLength(0);
    expect((await engine.getChunks('first')).every(chunk => !chunk.embedded_at)).toBe(true);
    let release!: () => void;
    state.delay = new Promise<void>(resolve => { release = resolve; });
    try {
      state.cpu = 0.1; state.now += 20000;
      await until(async () => calls.length, count => count > 0, '空闲后没有启动向量模型');
      await runtime.adjustResourcePressure(true);
      const nextPath = join(directory, 'second.md');
      writeFileSync(nextPath, '# 第二份\n\n慢向量模型运行期间继续导入。');
      const next = await runtime.submitImport({ path: nextPath });
      const completed = await until(() => runtime.getRun(next.id), row => row?.status === 'completed', '向量模型堵住导入');
      expect(completed!.status).toBe('completed');
      expect((await runtime.listRuns()).filter(row => row.searchOptimize && ['queued', 'running'].includes(row.status)).map(row => row.id)).toEqual([vectorTask.id]);
      expect((await engine.getPage('second'))?.compiled_truth).toContain('慢向量模型');
    } finally { state.delay = undefined; release(); await runtime.adjustResourcePressure(false); }
    await until(() => runtime.listRuns(), rows => rows.some(row => row.searchOptimize && row.status === 'completed'), '没有自动完成向量化');
    for (const slug of ['first', 'second']) {
      const chunks = await engine.getChunks(slug);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every(chunk => !!chunk.embedded_at && chunk.model === 'custom-openai:background-test')).toBe(true);
    }
    expect((await engine.getPage('first'))?.compiled_truth).toContain('原始资料内容');
  });
}, 90000);

test('半闲置每次少量处理，电脑变忙后保存本批并等待，恢复后不重复已经完成的切块', async () => {
  await fixture(async ({ engine, runtime, calls, state }) => {
    state.cpu = 0.55;
    await engine.putPage('many', { title: '很多段', type: 'note', compiled_truth: '测试原文' });
    await engine.upsertChunks('many', Array.from({ length: 12 }, (_, index) => ({ chunk_index: index, chunk_text: `第 ${index} 段原始资料`, chunk_source: 'compiled_truth' as const })));
    state.onRequest = () => { state.cpu = 0.95; };
    const accepted = await runtime.acceptSearchOptimize('default', ['many']);
    await until(() => runtime.getRun(`task-${accepted.jobId}`), row => row?.status === 'queued' && row.product?.background?.mode === 'waiting', '忙时没有让路');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    expect((await engine.getChunks('many')).filter(chunk => chunk.embedded_at)).toHaveLength(4);
    state.onRequest = undefined; state.cpu = 0.1; state.now += 20000;
    await until(() => runtime.getRun(`task-${accepted.jobId}`), row => row?.status === 'completed', '空闲后未继续');
    expect(calls.flat()).toHaveLength(12);
    expect(new Set(calls.flat()).size).toBe(12);
    expect((await engine.getChunks('many')).every(chunk => !!chunk.embedded_at)).toBe(true);
  });
}, 90000);

test('手动暂停跨重启保留，新导入仍成功但不解除暂停，继续后向量持久化', async () => {
  await fixture(async ctx => {
    const { engine, directory, calls, state } = ctx;
    state.cpu = 0.95;
    writeFileSync(join(directory, 'before.md'), '# 暂停前\n\n暂停前导入的资料。');
    const first = await ctx.runtime.submitImport({ path: join(directory, 'before.md') });
    await until(() => ctx.runtime.getRun(first.id), row => row?.status === 'completed', '导入未完成');
    const vectorRun = (await ctx.runtime.listRuns()).find(row => row.searchOptimize)!;
    await ctx.runtime.pauseSearchOptimize(vectorRun.id);
    await ctx.restart();
    state.cpu = 0.1; state.now += 20000;
    writeFileSync(join(directory, 'after.md'), '# 暂停后\n\n暂停后导入的资料。');
    const second = await ctx.runtime.submitImport({ path: join(directory, 'after.md') });
    await until(() => ctx.runtime.getRun(second.id), row => row?.status === 'completed', '暂停不应阻止导入');
    expect((await ctx.runtime.getRun(vectorRun.id))?.status).toBe('paused');
    expect(calls).toHaveLength(0);
    await ctx.runtime.continueSearchOptimize(vectorRun.id);
    await until(() => ctx.runtime.getRun(vectorRun.id), row => row?.status === 'completed', '手动继续没有完成');
    await ctx.restart();
    for (const slug of ['before', 'after']) expect((await engine.getChunks(slug)).every(chunk => !!chunk.embedded_at)).toBe(true);
    expect((await ctx.runtime.getRun(vectorRun.id))?.status).toBe('completed');
  });
}, 90000);

test('慢模型运行中暂停立即给出反馈，当前批次保存后不再发起请求', async () => {
  await fixture(async ({ engine, runtime, calls, state }) => {
    state.cpu = 0.55;
    await engine.putPage('pause-running', { title: '运行中暂停', type: 'note', compiled_truth: '保留当前批次' });
    await engine.upsertChunks('pause-running', Array.from({ length: 8 }, (_, chunk_index) => ({ chunk_index, chunk_text: `暂停测试 ${chunk_index}`, chunk_source: 'compiled_truth' as const })));
    let release!: () => void;
    state.delay = new Promise<void>(resolve => { release = resolve; });
    const accepted = await runtime.acceptSearchOptimize('default', ['pause-running']);
    const id = `task-${accepted.jobId}`;
    try {
      await until(async () => calls.length, count => count === 1, '模型请求没有开始');
      const pausing = await runtime.pauseSearchOptimize(id);
      expect(pausing?.product?.stage).toBe('正在暂停，当前批次保存后停止');
    } finally { state.delay = undefined; release(); }
    await until(() => runtime.getRun(id), row => row?.status === 'paused', '当前批次没有完成暂停');
    expect(calls).toHaveLength(1);
    expect((await engine.getChunks('pause-running')).filter(chunk => chunk.embedded_at)).toHaveLength(4);
    await runtime.continueSearchOptimize(id);
    await until(() => runtime.getRun(id), row => row?.status === 'completed', '暂停后没有继续');
    expect(calls.flat()).toHaveLength(8);
  });
}, 90000);

test('向量服务暂时失败不影响导入成功，保留原任务并自动重试', async () => {
  await fixture(async ({ engine, runtime, directory, state }) => {
    state.fail = true;
    writeFileSync(join(directory, 'retry.md'), '# 暂时离线\n\n模型恢复以后继续向量化。');
    const imported = await runtime.submitImport({ path: join(directory, 'retry.md') });
    await until(() => runtime.getRun(imported.id), row => row?.status === 'completed', '向量服务失败不应使导入失败');
    const rows = await until(() => runtime.listRuns(), list => list.some(row => row.searchOptimize && row.product?.stage.includes('自动重试')), '没有保留自动重试状态');
    const vectors = rows.find(row => row.searchOptimize)!;
    expect(vectors.status).toBe('queued');
    expect((await engine.getPage('retry'))?.compiled_truth).toContain('模型恢复');
    state.fail = false;
    await engine.executeRaw('UPDATE minion_jobs SET delay_until=now() WHERE id=$1', [Number(vectors.id.slice(5))]);
    await until(() => runtime.getRun(vectors.id), row => row?.status === 'completed', '模型恢复后没有自动继续原任务');
    expect((await runtime.getRun(imported.id))?.status).toBe('completed');
    expect((await engine.getChunks('retry')).every(chunk => !!chunk.embedded_at)).toBe(true);
  });
}, 90000);

test('旧版数据库中断的导入从保存点继续，停止过的任务不自动复活', async () => {
  await fixture(async ctx => {
    const { engine, directory, state } = ctx;
    state.cpu = 0.95;
    writeFileSync(join(directory, 'recovered.md'), '# 已保存\n\n数据库恢复后不用重新导入。');
    const imported = await ctx.runtime.submitImport({ path: join(directory, 'recovered.md') });
    await until(() => ctx.runtime.getRun(imported.id), row => row?.status === 'completed', '初次导入未完成');
    await engine.executeRaw(`UPDATE minion_jobs SET status='paused',result=NULL,error_text='数据库执行曾中断，请查看已完成资料后手动继续。' WHERE id=$1`, [Number(imported.id.slice(5))]);
    await ctx.restart();
    const recovered = await until(() => ctx.runtime.getRun(imported.id), row => row?.status === 'completed', '没有自动继续被数据库恢复波及的导入');
    expect(recovered!.result).toMatchObject({ resumedFiles: 1 });
    expect((await engine.listPages({ sourceId: 'default', limit: 100 })).filter(page => page.slug === 'recovered')).toHaveLength(1);
    const vectors = (await ctx.runtime.listRuns()).find(row => row.searchOptimize)!;
    await ctx.runtime.pauseSearchOptimize(vectors.id);
    await ctx.restart();
    expect((await ctx.runtime.getRun(vectors.id))!.status).toBe('paused');
  });
}, 90000);

test('导入失败不会停掉知识向量化；被停止的向量任务空闲后继续，手动暂停仍然保留', async () => {
  await fixture(async ctx => {
    const { engine, directory, calls, state } = ctx;
    state.cpu = 0.95;
    writeFileSync(join(directory, 'kept.md'), '# 已保存\n\n导入失败不能带走向量化。');
    const imported = await ctx.runtime.submitImport({ path: join(directory, 'kept.md') });
    await until(() => ctx.runtime.getRun(imported.id), row => row?.status === 'completed', '导入未完成');
    const vectors = (await ctx.runtime.listRuns()).find(row => row.searchOptimize)!;
    await engine.executeRaw(`UPDATE minion_jobs SET status='dead', error_text='任务已停止', lock_token=NULL, lock_until=NULL, finished_at=now() WHERE id=$1`, [Number(vectors.id.slice(5))]);
    writeFileSync(join(directory, 'huge.md'), Buffer.alloc(5_000_001, 0x61));
    const failed = await ctx.runtime.submitImport({ path: join(directory, 'huge.md') });
    let failedRun = await ctx.runtime.getRun(failed.id);
    const failedDeadline = Date.now() + 25000;
    while (failedRun?.status !== 'failed' && Date.now() < failedDeadline) {
      await Bun.sleep(40);
      failedRun = await ctx.runtime.getRun(failed.id);
    }
    if (failedRun?.status !== 'failed') throw new Error(`超限导入没有按导入失败结束：${failedRun?.status ?? 'missing'} ${failedRun?.error ?? ''}`);
    expect(String(failedRun?.error)).toContain('文件过大');
    expect((await engine.getPage('kept'))?.compiled_truth).toContain('导入失败不能带走');
    state.cpu = 0.1;
    state.now += 20000;
    await until(() => ctx.runtime.getRun(vectors.id), row => row?.status === 'completed', '空闲后没有继续被停止的知识向量化');
    expect((await engine.getChunks('kept')).every(chunk => !!chunk.embedded_at)).toBe(true);
    expect((await ctx.runtime.getRun(failed.id))?.status).toBe('failed');
    state.cpu = 0.95;
    await engine.putPage('paused-page', { title: '暂停', type: 'note', compiled_truth: '手动暂停不能被空闲解除' });
    await engine.upsertChunks('paused-page', [{ chunk_index: 0, chunk_text: '手动暂停不能被空闲解除', chunk_source: 'compiled_truth' }]);
    const paused = await ctx.runtime.acceptSearchOptimize('default', ['paused-page']);
    await ctx.runtime.pauseSearchOptimize(`task-${paused.jobId}`);
    await engine.executeRaw(`UPDATE minion_jobs SET status='dead', error_text='任务已停止', lock_token=NULL, lock_until=NULL, finished_at=now() WHERE id=$1`, [paused.jobId]);
    const seen = calls.length;
    state.cpu = 0.1;
    state.now += 20000;
    await Bun.sleep(1200);
    await ctx.restart();
    state.cpu = 0.1;
    state.now += 20000;
    await Bun.sleep(300);
    expect(calls.length).toBe(seen);
    expect((await engine.getChunks('paused-page')).every(chunk => !chunk.embedded_at)).toBe(true);
  });
}, 90000);
