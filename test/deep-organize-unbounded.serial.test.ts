import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { ProductTaskRuntime, PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import { SYNC_FILE_QUEUE, SYNC_FILE_TASK } from '../src/product/tasks/sync-file-queue.ts';
import { DOCUMENT_OCR_QUEUE, DOCUMENT_OCR_TASK } from '../src/core/pmbrain-adapters/deferred-document-ocr.ts';
import { IMAGE_BACKLOG_REASON } from '../src/core/pmbrain-adapters/image-ocr-policy.ts';
import { DREAM_TASK_TIMEOUT_KEY, SLEEP_INTERRUPT_REASON } from '../src/product/tasks/timeout.ts';
import { imageOcrAdmission } from '../src/core/pmbrain-adapters/image-ocr-policy.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { idleBackground } from './helpers/background-resources';

const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_TEST_ALLOW_DATABASE_URL'];
const saved = keys.map(key => process.env[key]);
let home: string, engine: BrainEngine;
let modelCalls = 0;
let modelServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-deep-unbounded-'));
  keys.forEach(key => delete process.env[key]);
  process.env.PMBRAIN_HOME = home;
  process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.pmbrain'));
  modelServer = Bun.serve({ port: 0, fetch: () => { modelCalls++; return Response.json({ id: 'isolated-deep', object: 'chat.completion', model: 'isolated-capture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ entities: [], relations: [], no_entities: true }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }); } });
  writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify({ engine: database ? 'postgres' : 'pglite', custom_openai_api_key: 'isolated-only', provider_base_urls: { 'custom-openai': modelServer.url.origin + '/v1' }, models: { default: 'custom-openai:isolated-capture' }, model_usage: { embedding_enabled: false, generative_enabled: true } }));
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database ? { database_url: database } : {});
  await engine.initSchema();
  await engine.setConfig('pricing.overrides', JSON.stringify({ 'custom-openai:isolated-capture': { input: 1, output: 1 } }));
}, 60000);

afterAll(async () => {
  await engine?.disconnect();
  modelServer?.stop(true);
  keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  if (home) {
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep + 'pmbrain-deep-unbounded-')) throw new Error('测试目录范围不正确');
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);

async function clearJobs() {
  await engine.executeRaw('DELETE FROM minion_jobs');
}

test('深度整理不保存 6 小时上限，继续旧任务后也不再限时，休眠后可以继续', async () => {
  await engine.setConfig(DREAM_TASK_TIMEOUT_KEY, '420000');
  const runtime = new ProductTaskRuntime(engine);
  try {
    expect(await imageOcrAdmission(engine, true)).toEqual({ ok: false, reason: '图片识别未开启' });
    expect(await imageOcrAdmission(engine, undefined)).toEqual({ ok: true });
    const queue = new MinionQueue(engine);
    for (const trigger of ['manual', 'scheduled'] as const) {
      const run = await runtime.submitDream({ preset: 'full', sourceId: 'deep-limit', dryRun: true, timeoutMs: 180000 }, trigger);
      const saved = await queue.getJob(Number(run.id.slice(5)));
      expect(saved?.timeout_ms).toBeNull();
      expect(saved?.data.unboundedRuntime).toBe(true);
      expect((saved?.data.task as { input: { timeoutMs?: number } }).input.timeoutMs).toBeUndefined();
    }
    const quick = await runtime.submitDream({ preset: 'quick', sourceId: 'deep-limit', dryRun: true });
    expect((await queue.getJob(Number(quick.id.slice(5))))?.timeout_ms).toBe(420000);
    const backlinks = await runtime.submitDream({ phase: 'backlinks', sourceId: 'deep-limit', dryRun: true });
    expect((await queue.getJob(Number(backlinks.id.slice(5))))?.timeout_ms).toBe(420000);
    const old = await runtime.submitDream({ preset: 'full', sourceId: 'deep-limit', dryRun: true, timeoutMs: 180000 });
    const oldId = Number(old.id.slice(5));
    await engine.executeRaw(`UPDATE minion_jobs SET status='failed', timeout_ms=21600000, timeout_at=now(), error_text='wall-clock timeout exceeded', data=data-'unboundedRuntime' WHERE id=$1`, [oldId]);
    expect((await runtime.retry(old.id))?.id).toBe(old.id);
    const retried = await queue.getJob(oldId);
    expect(retried?.status).toBe('waiting');
    expect(retried?.timeout_ms).toBeNull();
    expect(retried?.data.unboundedRuntime).toBe(true);
    expect((retried?.data.task as { input: { timeoutMs?: number } }).input.timeoutMs).toBeUndefined();
    const paused = await runtime.pauseForSleep();
    expect(paused).toBeGreaterThanOrEqual(1);
    const asleep = await queue.getJob(oldId);
    expect(asleep?.status).toBe('paused');
    expect(asleep?.error_text).toBe(SLEEP_INTERRUPT_REASON);
    expect(asleep?.timeout_at).toBeNull();
    expect(await runtime.resumeAfterSleep()).toBeGreaterThanOrEqual(1);
    const awake = await queue.getJob(oldId);
    expect(awake?.status).toBe('waiting');
    expect(awake?.timeout_ms).toBeNull();
    expect(awake?.data.unboundedRuntime).toBe(true);
    expect(awake?.error_text ?? '').not.toContain('休眠');
  } finally {
    await runtime.close();
    await clearJobs();
    await engine.setConfig(DREAM_TASK_TIMEOUT_KEY, '');
  }
}, 60000);

test('启动时清掉图片积压，深度整理进行时图片识别让出文件队列', async () => {
  const queue = new MinionQueue(engine);
  const image = await queue.add(SYNC_FILE_TASK, { task: { type: 'sync-file', input: { relativePath: 'shot.PNG' } } }, { queue: SYNC_FILE_QUEUE });
  const note = await queue.add(SYNC_FILE_TASK, { task: { type: 'sync-file', input: { relativePath: 'note.md' } } }, { queue: SYNC_FILE_QUEUE, delay: 24 * 60 * 60 * 1000 });
  const backlog = await queue.add(DOCUMENT_OCR_TASK, { kind: 'document_ocr', task: { type: 'import', input: { ocrOnly: { image: true, relativePath: 'shot.PNG' } } } }, { queue: DOCUMENT_OCR_QUEUE });
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground });
  await runtime.start();
  try {
    expect((await queue.getJob(image.id))?.status).toBe('cancelled');
    expect((await queue.getJob(image.id))?.error_text).toBe(IMAGE_BACKLOG_REASON);
    expect((await queue.getJob(backlog.id))?.status).toBe('cancelled');
    expect((await queue.getJob(note.id))?.status).toBe('delayed');
    const [dream] = await engine.executeRaw<{ id: number }>(`INSERT INTO minion_jobs(queue,name,status,lock_token,lock_until,data)
      VALUES($1,'pmbrain-product-task','active','deep-hold',now()+interval '30 minutes',$2::jsonb) RETURNING id`, [PRODUCT_TASK_QUEUE, { unboundedRuntime: true, kind: 'dream_full', task: { type: 'dream', input: { preset: 'full', sourceId: 'deep-limit' } } }]);
    const first = await queue.add(DOCUMENT_OCR_TASK, { kind: 'document_ocr', task: { type: 'import', input: { path: join(home, 'a.png'), ocrOnly: { image: true, relativePath: 'a.png', hash: 'a', slug: 'a', sourceIncarnation: '1', sourceRoot: home, ownedSnapshot: false } } } }, { queue: DOCUMENT_OCR_QUEUE, priority: 10 });
    const second = await queue.add(DOCUMENT_OCR_TASK, { kind: 'document_ocr', task: { type: 'import', input: { path: join(home, 'b.png'), ocrOnly: { image: true, relativePath: 'b.png', hash: 'b', slug: 'b', sourceIncarnation: '1', sourceRoot: home, ownedSnapshot: false } } } }, { queue: DOCUMENT_OCR_QUEUE, priority: 10 });
    const deadline = Date.now() + 15000;
    let rows: Array<{ id: number; status: string; wait: number | null }> = [];
    while (Date.now() < deadline) {
      rows = await engine.executeRaw(`SELECT id, status, EXTRACT(EPOCH FROM (delay_until - now()))::float AS wait FROM minion_jobs WHERE id = ANY($1::int[])`, [[first.id, second.id]]);
      if (rows.length === 2 && rows.every(row => row.status === 'delayed' && (row.wait ?? 0) >= 30)) break;
      await Bun.sleep(100);
    }
    expect(rows.map(row => row.status), JSON.stringify(rows)).toEqual(['delayed', 'delayed']);
    expect(rows.every(row => (row.wait ?? 0) >= 30)).toBe(true);
    expect((await queue.getJob(dream.id))?.status).toBe('active');
  } finally {
    await runtime.close();
    await clearJobs();
  }
}, 60000);

test('没有新文件时跳过内容综合，并续接已提交的实体识别', async () => {
  const repo = join(home, 'quiet-source');
  mkdirSync(repo);
  writeFileSync(join(repo, 'note.md'), '# 安静资料\n\n这份资料已经整理过，再跑一轮不应整库重做。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('deep-quiet','无变化验收',$1,'{}'::jsonb)", [repo]);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground });
  await runtime.start();
  const ended = async (id: string) => {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const run = await runtime.getRun(id);
      if (run && !['running', 'queued'].includes(run.status)) return run;
      await Bun.sleep(150);
    }
    throw new Error(JSON.stringify(await runtime.getRun(id)));
  };
  try {
    const quick = await ended((await runtime.submitDream({ preset: 'quick', sourceId: 'deep-quiet' })).id);
    expect(quick.status, JSON.stringify(quick)).toBe('completed');
    expect((await engine.getPage('note', { sourceId: 'deep-quiet' }))?.compiled_truth).toContain('已经整理过');
    modelCalls = 0;
    const full = await ended((await runtime.submitDream({ preset: 'full', sourceId: 'deep-quiet', maxPages: 1 })).id);
    expect(full.status, JSON.stringify(full)).toBe('completed');
    expect(modelCalls, JSON.stringify(full.product?.deep)).toBe(1);
    const stages = full.product?.deep?.stages ?? [];
    const stage = (id: string) => stages.find(item => item.id === id);
    expect(stage('relations')?.status).toBe('skipped');
    expect(stage('relations')?.result).toBe('跳过');
    expect(stage('entities')?.status).not.toBe('skipped');
    expect(stage('entities')?.result).toContain('写入 0 个实体');
    for (const id of ['concepts', 'index', 'review']) expect(stage(id)?.status, JSON.stringify(stage(id))).toBe('skipped');
    const log = full.product?.deep?.log ?? [];
    expect(log.some(entry => entry.event === 'start' && entry.stage === 'relations')).toBe(true);
    expect(log.some(entry => entry.event === 'finish' && entry.stage === 'relations' && entry.result === '跳过' && typeof entry.durationMs === 'number')).toBe(true);
    expect((await runtime.files(full.id))?.rows ?? []).toHaveLength(0);
  } finally {
    await runtime.close();
    await clearJobs();
  }
}, 180000);
