import { expect, spyOn, test } from 'bun:test';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
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
    await Bun.sleep(25);
  }
  throw new Error(label);
}

async function fixture(run: (ctx: { engine: BrainEngine; runtime: ProductTaskRuntime; directory: string }) => Promise<void>) {
  const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_TASK_TEST_DATABASE_URL', 'PMBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_MODEL', 'PMBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBEDDING_DIMENSIONS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-review-optimize-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root;
  process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  const directory = join(root, 'materials');
  mkdirSync(directory);
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json() as { input?: unknown[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({ object: 'list', data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) })), model: 'review-test', usage: { prompt_tokens: 2, total_tokens: 2 } });
  } });
  writeFileSync(configPath(), JSON.stringify({
    engine: 'pglite', embedding_model: 'custom-openai:review-test', embedding_dimensions: 1024,
    custom_openai_api_key: 'isolated-review-only', provider_base_urls: { 'custom-openai': server.url.origin + '/v1' },
    model_usage: { embedding_enabled: true, generative_enabled: false },
    desktop: { knowledge_directory: root, model_services: [{ id: 'review-test', provider: 'custom-openai', name: 'review', baseUrl: server.url.origin + '/v1', apiKey: 'isolated-review-only', enabled: true, models: [{ id: 'review-test', name: 'review', kind: 'embedding', capabilities: [], inputPriceCny: 0, outputPriceCny: 0, pricingSource: 'manual' }] }] },
  }));
  const engine = new WorkerPgliteEngine() as unknown as BrainEngine;
  let runtime: ProductTaskRuntime | undefined;
  try {
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [directory, 'default']);
    await engine.setConfig('dream.entity_capture.enabled', 'false');
    await reloadLiveGateway(engine);
    runtime = new ProductTaskRuntime(engine);
    await runtime.start();
    await run({ engine, runtime, directory });
  } finally {
    await runtime?.close();
    await engine.disconnect();
    server.stop(true);
    resetGateway();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('目录导入中途停止后继续，已经保存的文件也会完成向量化', async () => {
  await fixture(async ({ engine, runtime, directory }) => {
    writeFileSync(join(directory, 'a.md'), '# 第一份\n\n第一份已入库资料需要补全向量。');
    writeFileSync(join(directory, 'b.md'), '# 第二份\n\n第二份在第一次运行时尚未读取。');
    let firstCheckpoint = false;
    let intercepted = false;
    let hit!: () => void;
    const stoppedBeforeSecond = new Promise<void>(resolve => { hit = resolve; });
    const emit = Worker.prototype.emit;
    const hook = spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: any[]) {
      const message = args[0];
      if (event === 'message' && message?.type === 'rpc') {
        if (message.method === 'task.checkpoint' && message.args?.[0]?.completed === true) firstCheckpoint = true;
        if (firstCheckpoint && !intercepted && message.method === 'task.inputFile') {
          intercepted = true;
          hit();
          return true;
        }
      }
      return emit.call(this, event, ...args);
    });
    let accepted: Awaited<ReturnType<typeof runtime.submitImport>>;
    let savedSlug = '';
    try {
      accepted = await runtime.submitImport({ path: directory });
      await Promise.race([stoppedBeforeSecond, Bun.sleep(25000).then(() => { throw new Error('未到达第二份资料之前'); })]);
      const saved = await engine.listPages({ sourceId: 'default', limit: 100 });
      expect(saved).toHaveLength(1);
      savedSlug = saved[0]!.slug;
      await runtime.cancel(accepted.id);
    } finally {
      hook.mockRestore();
    }
    await runtime.retry(accepted!.id);
    const imported = await until(() => runtime.getRun(accepted!.id), run => !!run && !['queued', 'running'].includes(run.status), '继续导入未结束');
    expect(imported?.status).toBe('completed');
    expect(imported?.result).toMatchObject({ resumedFiles: 1 });
    await until(() => runtime.listRuns(), runs => !runs.some(run => run.searchOptimize && ['queued', 'running'].includes(run.status)), '后台优化未结束');
    const chunks = await engine.getChunks(savedSlug, { sourceId: 'default' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => !!chunk.embedded_at)).toBe(true);
  });
}, 60000);

test('同一份资料在优化期间更新后，旧的完成回执不会把它标成已完成', async () => {
  await fixture(async ({ engine, runtime, directory }) => {
    const path = join(directory, 'race.md');
    writeFileSync(path, '# 原始版本\n\n这是第一版内容。');
    let hit!: () => void;
    const beforeDone = new Promise<void>(resolve => { hit = resolve; });
    let deliver: (() => void) | undefined;
    const emit = Worker.prototype.emit;
    const hook = spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: any[]) {
      const message = args[0];
      if (!deliver && event === 'message' && message?.type === 'rpc' && message.method === 'task.searchOptimizeDone') {
        deliver = () => { emit.call(this, event, ...args); };
        hit();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    try {
      const first = await runtime.submitImport({ path });
      await until(() => runtime.getRun(first.id), run => !!run && !['queued', 'running'].includes(run.status), '初次导入未结束');
      await Promise.race([beforeDone, Bun.sleep(25000).then(() => { throw new Error('未到达首次向量完成回执'); })]);
      writeFileSync(path, '# 更新版本\n\n这份新内容在旧完成回执之前入库，需要重新生成向量。');
      const second = await runtime.submitImport({ path });
      const updated = await until(() => runtime.getRun(second.id), run => !!run && !['queued', 'running'].includes(run.status), '更新导入未结束');
      expect(updated?.status).toBe('completed');
      hook.mockRestore();
      deliver!();
      await until(() => runtime.listRuns(), runs => !runs.some(run => run.searchOptimize && ['queued', 'running'].includes(run.status)), '后台优化未结束');
      const chunks = await engine.getChunks('race', { sourceId: 'default' });
      expect(chunks.some(chunk => chunk.chunk_text.includes('新内容'))).toBe(true);
      expect(chunks.every(chunk => !!chunk.embedded_at)).toBe(true);
    } finally {
      hook.mockRestore();
      deliver?.();
    }
  });
}, 60000);
