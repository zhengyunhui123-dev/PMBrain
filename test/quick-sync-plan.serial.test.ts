import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';
import { configPath } from '../src/core/config';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { idleBackground } from './helpers/background-resources';

let engine: BrainEngine, runtime: ProductTaskRuntime, root: string;
const databaseUrl = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_DATABASE_URL'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

async function until<T>(read: () => Promise<T | undefined>, timeout = 90000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result !== undefined) return result; await Bun.sleep(30); }
  throw new Error(JSON.stringify((await runtime.listRuns()).map(run => ({ id: run.id, status: run.status, stage: run.product?.stage, error: run.error }))));
}
const finished = (id: string) => until(async () => { const run = await runtime.getRun(id); return run && !['queued', 'running'].includes(run.status) ? run : undefined; });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-fixed-sync-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  writeFileSync(configPath(), JSON.stringify({ engine: databaseUrl ? 'postgres' : 'pglite', model_usage: { generative_enabled: false, embedding_enabled: false } }));
  engine = databaseUrl ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {}); await engine.initSchema();
  await engine.setConfig('sync.auto_git_commit', 'false');
  await engine.setConfig('dream.entity_capture.enabled', 'true');
  runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
}, 60000);

afterAll(async () => {
  await runtime?.close(); await engine?.disconnect();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('pmbrain-fixed-sync-')) rmSync(root, { recursive: true, force: true });
}, 60000);

test('扫描后固定增量清单；途中新增文件留到下一轮，多Source总数不重置', async () => {
  for (const source of ['default', 'fixed-work']) {
    const dir = join(root, source); mkdirSync(dir);
    for (let index = 0; index < 8; index++) writeFileSync(join(dir, `item-${index}.md`), `# 本轮资料 ${source} ${index}\n\n李明负责青山项目。`);
    if (source === 'default') await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [dir, source]);
    else await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}'::jsonb)", [source, dir]);
  }
  await engine.putPage('people/li', { title: '李明', type: 'person', compiled_truth: '# 李明\n\n已有人员资料。', frontmatter: {}, timeline: '' }, { sourceId: 'default' });
  await engine.putPage('projects/qingshan', { title: '青山项目', type: 'project', compiled_truth: '# 青山项目\n\n已有项目资料。', frontmatter: {}, timeline: '' }, { sourceId: 'default' });
  const id = (await runtime.submitDream({ preset: 'quick', allSources: true })).id;
  await until(async () => {
    const run = await runtime.getRun(id), round = run?.product?.maintenance;
    return round?.scan.complete && round.scan.incremental === 16 ? true : undefined;
  });
  writeFileSync(join(root, 'default', 'arrived-later.md'), '# 稍后新增\n\n应留到下一轮。');
  const done = await finished(id);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect(done.product?.maintenance?.scan).toMatchObject({ total: 16, incremental: 16, complete: true });
  expect(done.product?.syncFiles?.completed).toBe(16);
  expect(await engine.getPage('arrived-later', { sourceId: 'default' })).toBeNull();
  expect(done.product?.maintenance?.entities.total).toBeGreaterThanOrEqual(2);
  expect(done.product?.maintenance?.stages.map(stage => stage.id)).toEqual(['sync', 'relations', 'check']);
  expect((await engine.getPage('people/li', { sourceId: 'default' }))?.compiled_truth).toBe('# 李明\n\n已有人员资料。');
  const jobs = await engine.executeRaw<{ data: any }>('SELECT data FROM minion_jobs WHERE id=$1', [Number(id.slice(5))]);
  expect(Object.keys(jobs[0].data.task.input.checkpoint.quickSync.sources)).toHaveLength(2);
  expect(Object.values(jobs[0].data.task.input.checkpoint.quickSync.sources).every((source: any) => source.complete)).toBe(true);
}, 180000);

test('下一轮只导入新增资料，保留扫描总量和阶段最终统计', async () => {
  const id = (await runtime.submitDream({ preset: 'quick', allSources: true })).id;
  const done = await finished(id);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect(done.product?.maintenance?.scan).toMatchObject({ total: 17, unchanged: 16, incremental: 1, complete: true });
  expect(done.product?.syncFiles?.total).toBe(1);
  expect(done.product?.syncFiles?.completed).toBe(1);
  expect(await engine.getPage('arrived-later', { sourceId: 'default' })).not.toBeNull();
  const stages = done.product?.maintenance?.stages ?? [];
  expect(stages).toHaveLength(3);
  expect(stages.every(stage => ['completed','skipped'].includes(stage.status))).toBe(true);
}, 180000);

test('停止重启后复用固定清单；新增文件不混入旧轮次', async () => {
  const dir = join(root, 'resume'); mkdirSync(dir);
  for (let index = 0; index < 12; index++) writeFileSync(join(dir, `resume-${index}.md`), `# 恢复资料 ${index}\n\n${'隔离的同步验收正文。'.repeat(500)}`);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('fixed-resume','fixed-resume',$1,'{}'::jsonb)", [dir]);
  const id = (await runtime.submitDream({ preset: 'quick', sourceId: 'fixed-resume' })).id;
  await until(async () => (await runtime.getRun(id))?.product?.maintenance?.scan.complete ? true : undefined);
  await runtime.cancel(id);
  await finished(id);
  await runtime.close();
  writeFileSync(join(dir, 'after-restart.md'), '# 旧轮次之外\n\n下一轮才导入。');
  runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  const resumed = await runtime.retry(id);
  expect(resumed).not.toBeNull();
  const done = await finished(resumed!.id);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect(done.product?.maintenance?.scan).toMatchObject({ total: 12, incremental: 12, complete: true });
  expect(done.product?.syncFiles?.total).toBe(12);
  expect(done.product?.syncFiles?.completed).toBe(12);
  expect(await engine.getPage('after-restart', { sourceId: 'fixed-resume' })).toBeNull();
}, 240000);

test('失败不计作已导入；修复原文件后仅核对未完成文件，继续同一轮清单',async()=>{
  const dir=join(root,'failed');mkdirSync(dir);
  writeFileSync(join(dir,'good.md'),'# 成功资料\n\n已经写入的资料应保留。');
  writeFileSync(join(dir,'bad.md'),'---\nslug: wrong-target\n---\n# 失败资料\n\n需要修复的原文件。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('fixed-failed','fixed-failed',$1,'{}'::jsonb)",[dir]);
  const run=await finished((await runtime.submitDream({preset:'quick',sourceId:'fixed-failed'})).id);
  expect(run.product?.syncFiles).toMatchObject({total:2,completed:1,failed:1});
  expect(run.product?.maintenance?.stages.find(stage=>stage.id==='sync')).toMatchObject({completed:1,total:2,status:'partial'});
  const original=await engine.getPage('good',{sourceId:'fixed-failed'});
  writeFileSync(join(dir,'bad.md'),'# 修复后的资料\n\n继续时只重读这份失败资料。');
  const resumed=await runtime.retry(run.id);expect(resumed?.id).toBe(run.id);
  const done=await finished(run.id);
  expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect(done.product?.syncFiles).toMatchObject({total:2,completed:2,failed:0});
  expect(done.product?.maintenance?.scan).toMatchObject({total:2,incremental:2});
  expect((await engine.getPage('good',{sourceId:'fixed-failed'}))?.content_hash).toBe(original?.content_hash);
  expect((await engine.getPage('bad',{sourceId:'fixed-failed'}))?.compiled_truth).toContain('修复后的资料');
},180000);
