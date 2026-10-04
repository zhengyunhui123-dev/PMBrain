import { afterAll, beforeAll, expect, test } from 'bun:test';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import type { BrainEngine } from '../src/core/engine';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import { withDatabasePriority } from '../src/product/database/priority';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseAlreadyOwnedError } from '../src/core/pglite-errors';

let engine: BrainEngine;
const originalHome = [process.env.PMBRAIN_HOME, process.env.GBRAIN_HOME];
let home: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-database-worker-'));
  process.env.PMBRAIN_HOME = home;
  process.env.GBRAIN_HOME = home;
  configureGateway({ env: {} });
  engine = new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({});
  await engine.initSchema();
}, 60000);
afterAll(async () => {
  await engine?.disconnect(); resetGateway();
  for (const [index, key] of ['PMBRAIN_HOME', 'GBRAIN_HOME'].entries()) {
    if (originalHome[index] === undefined) delete process.env[key]; else process.env[key] = originalHome[index];
  }
  if (home) rmSync(home, { recursive: true, force: true });
}, 60000);

test('重数据库计算期间服务线程仍能响应不读数据库的请求', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ models: ['test-model'] }) });
  try {
    let finished = false;
    const query = engine.executeRaw('SELECT sum(sqrt(i)) FROM generate_series(1, 6000000) i').finally(() => { finished = true; });
    await Bun.sleep(60);
    const started = performance.now();
    expect((await (await fetch(server.url)).json() as any).models).toEqual(['test-model']);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(finished).toBe(false);
    await query;
  } finally { server.stop(true); }
}, 30000);

test('同一所有者的事务回滚，嵌套写入使用保存点，时间与 Map 保留类型', async () => {
  await expect(engine.transaction(async tx => {
    await tx.setConfig('worker.rollback', 'bad');
    await tx.transaction(async nested => { await nested.setConfig('worker.nested', 'bad'); });
    throw new Error('rollback requested');
  })).rejects.toThrow('rollback requested');
  expect(await engine.getConfig('worker.rollback')).toBeNull();
  expect(await engine.getConfig('worker.nested')).toBeNull();
  await engine.transaction(async tx => {
    await tx.setConfig('worker.commit', 'kept');
    await tx.transaction(async nested => { await nested.setConfig('worker.nested', 'discarded'); throw new Error('nested rollback'); }).catch(() => {});
  });
  expect(await engine.getConfig('worker.commit')).toBe('kept');
  expect(await engine.getConfig('worker.nested')).toBeNull();
  const page = await engine.putPage('worker-types', { type: 'note', title: '合成资料', compiled_truth: '保持类型' }, { sourceId: 'default' });
  expect(page.updated_at instanceof Date).toBe(true);
  expect(await engine.resolveSlugsByPaths(['missing.md'], { sourceId: 'default' }) instanceof Map).toBe(true);
});

test('任务已有事务内事实写入不再依赖不存在的嵌套 db.transaction', async () => {
  await engine.transaction(async tx => {
    const fact = await tx.insertFact({ fact: '数据库 Worker 的隔离事实', kind: 'fact', source: 'test' }, { source_id: 'default' });
    expect(fact.id).toBeGreaterThan(0);
  });
});

test('当前事务不被打断，提交后用户、MCP、导入、后台按优先级和同级顺序执行', async () => {
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const active = withDatabasePriority(3, () => engine.transaction(async tx => {
    await tx.setConfig('priority', 'uncommitted');
    ready();
    await gate;
    await tx.setConfig('priority', 'committed');
    order.push('transaction');
  }));
  await started;
  const enqueue = (priority: 0 | 1 | 2 | 3, label: string) => withDatabasePriority(priority,
    () => engine.getConfig('priority').then(value => { expect(value).toBe('committed'); order.push(label); }));
  const waiting = [enqueue(3, 'background-1'), enqueue(2, 'import'), enqueue(1, 'mcp'), enqueue(0, 'user'), enqueue(3, 'background-2')];
  await Bun.sleep(60);
  expect(order).toEqual([]);
  release();
  await Promise.all([active, ...waiting]);
  expect(order).toEqual(['transaction', 'user', 'mcp', 'import', 'background-1', 'background-2']);
});

test('同一数据目录只允许一个 Worker 所有者，关闭重开保留内容', async () => {
  const previous = process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST;
  process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST = '1';
  const config = { database_path: join(home, 'reopen-db') };
  const first = new WorkerPgliteEngine() as unknown as BrainEngine;
  const second = new WorkerPgliteEngine() as unknown as BrainEngine;
  try {
    await first.connect(config);
    await first.initSchema();
    await first.setConfig('reopen.kept', 'kept');
    const rejected = await second.connect(config).catch(error => error);
    expect(rejected instanceof DatabaseAlreadyOwnedError).toBe(true);
    await second.disconnect();
    await first.disconnect();
    await second.connect(config);
    expect(await second.getConfig('reopen.kept')).toBe('kept');
  } finally {
    await first.disconnect();
    await second.disconnect();
    if (previous === undefined) delete process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST;
    else process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST = previous;
  }
}, 30000);
