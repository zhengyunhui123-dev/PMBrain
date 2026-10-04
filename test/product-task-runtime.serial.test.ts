import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { withDatabasePriority } from '../src/product/database/priority.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import type { ConsoleRun } from '../src/commands/natural-lang/types.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { TaskEngineHost } from '../src/product/tasks/engine-host.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { configPath } from '../src/core/config.ts';
import { purgeExpiredSources } from '../src/core/destructive-guard.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { purgeStaleVolunteerEvents } from '../src/core/context/volunteer-events.ts';

let engine: BrainEngine;
let runtime: ProductTaskRuntime;
let root: string;
const isolatedKeys = ['GBRAIN_HOME', 'PMBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_MODEL', 'PMBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBEDDING_DIMENSIONS'];
const taskDatabaseUrl = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const originalEnv = Object.fromEntries(isolatedKeys.map(key => [key, process.env[key]]));
let slowRequests = 0;
let releaseModel: (() => void) | null = null;
const releases = new Set<() => void>();
let modelServer: ReturnType<typeof Bun.serve>;

function configureModels(enabled = true, model = 'task-test') {
  writeFileSync(configPath(), JSON.stringify({
    engine: taskDatabaseUrl ? 'postgres' : 'pglite', embedding_model: `custom-openai:${model}`, embedding_dimensions: 1024,
    custom_openai_api_key: 'task-test-only', provider_base_urls: { 'custom-openai': modelServer.url.origin + '/v1' },
    model_usage: { embedding_enabled: enabled, generative_enabled: false },
    desktop: { knowledge_directory: root },
  }));
}

async function modelWaiting() {
  const deadline = Date.now() + 15_000;
  while (!releaseModel && Date.now() < deadline) await Bun.sleep(30);
  if (!releaseModel) throw new Error(JSON.stringify(await runtime.listRuns()));
}

function release() { for (const finish of releases) finish(); releases.clear(); releaseModel = null; }

async function finished(id: string): Promise<ConsoleRun> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const run = await runtime.getRun(id);
    if (run && !['running', 'queued'].includes(run.status)) return run;
    await Bun.sleep(30);
  }
  throw new Error(`Task ${id} did not finish`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-task-test-'));
  for (const key of isolatedKeys) delete process.env[key];
  process.env.GBRAIN_HOME = root;
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  modelServer = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { input: string[] };
    slowRequests++;
    await new Promise<void>(resolve => {
      const finish = () => { releases.delete(finish); resolve(); };
      releases.add(finish); releaseModel = finish;
    });
    return Response.json({ object: 'list', data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) })), model: 'task-test', usage: { prompt_tokens: 2, total_tokens: 2 } });
  } });
  configureModels(false);
  configureGateway({ embedding_model: 'custom-openai:task-test', embedding_dimensions: 1024, env: {} });
  if (taskDatabaseUrl) assertSafeE2eDatabaseUrl(taskDatabaseUrl);
  engine = taskDatabaseUrl ? new PostgresEngine() : process.env.PMBRAIN_TASK_TEST_WORKER === '1' ? new WorkerPgliteEngine() as unknown as BrainEngine : new PGLiteEngine();
  await engine.connect(taskDatabaseUrl ? { database_url: taskDatabaseUrl } : {});
  await engine.initSchema();
  runtime = new ProductTaskRuntime(engine);
  await runtime.start();
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await engine?.disconnect();
  release();
  modelServer?.stop(true);
  resetGateway();
  for (const key of isolatedKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('软件后台任务共用 owner 数据库', () => {
  test('两个任务可同时等待模型，停止立即确认且不依赖数据库队列', async () => {
    configureModels();
    const previous = slowRequests;
    const accepted: ConsoleRun[] = [];
    try {
      for (const name of ['parallel-a', 'parallel-b']) {
        const path = join(root, `${name}.md`);
        writeFileSync(path, `# ${name}\n\n合成资料验证非数据库阶段并行。`);
        accepted.push(await runtime.submitImport({ path }));
      }
      const deadline = Date.now() + 15_000;
      while (slowRequests < previous + 2 && Date.now() < deadline) await Bun.sleep(30);
      expect(slowRequests).toBe(previous + 2);
      let ready!: () => void;
      let unlock!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const gate = new Promise<void>(resolve => { unlock = resolve; });
      const busy = withDatabasePriority(3, () => engine.transaction(async tx => {
        await tx.setConfig('stop.batch', 'committed naturally'); ready(); await gate;
      }));
      await started;
      try {
        const now = performance.now();
        expect((await runtime.requestCancel(accepted[0].id))?.error).toContain('正在停止');
        expect((await runtime.listRuns()).find(row => row.id === accepted[0].id)?.status).toBe('running');
        expect(performance.now() - now).toBeLessThan(1000);
      } finally { unlock(); await busy; }
      expect(await engine.getConfig('stop.batch')).toBe('committed naturally');
      expect((await finished(accepted[0].id)).status).toBe('cancelled');
      await runtime.cancel(accepted[1].id);
      release();
      expect(await engine.getPage('parallel-a', { sourceId: 'default' })).toBeNull();
      expect(await engine.getPage('parallel-b', { sourceId: 'default' })).toBeNull();
    } finally {
      release();
      for (const run of accepted) await runtime.cancel(run.id);
      configureModels(false);
    }
  }, 30_000);

  test('批量关系每 50 条提交一次，关闭后不启动下一批', async () => {
    const queue = new MinionQueue(engine);
    await queue.add('batch-fence-test', {}, { queue: PRODUCT_TASK_QUEUE });
    const job = await queue.claim('batch-token', 30_000, PRODUCT_TASK_QUEUE, ['batch-fence-test']);
    let host: TaskEngineHost;
    const sizes: number[] = [];
    const owner = new Proxy(engine, { get(target, property) {
      if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, {
        get(current, key) {
          if (key === 'addLinksBatch') return async (rows: unknown[]) => {
            sizes.push(rows.length); void host.close(); return rows.length;
          };
          const value = Reflect.get(current, key); return typeof value === 'function' ? value.bind(current) : value;
        },
      })));
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    host = new TaskEngineHost(owner, job!.id, 'batch-token', async () => {});
    const rejected = await host.dispatch({ type: 'rpc', id: 1, method: 'addLinksBatch', args: [Array.from({ length: 151 }, () => ({ from_slug: 'a', to_slug: 'b' }))] }).catch(error => error);
    expect(String(rejected)).toContain('任务执行已停止');
    expect(sizes).toEqual([50]);
    await host.close();
    await queue.cancelJob(job!.id);
  });

  test('导入直接执行核心，原始文件保留，结果持久化并可由新运行时读取', async () => {
    const path = join(root, 'background.md');
    const content = '# 后台导入\n\n软件直接导入这份合成资料，并在任务中心保存结果。';
    writeFileSync(path, content);
    const accepted = await runtime.submitImport({ path, noEmbed: true });
    expect(accepted.product?.material).toMatchObject({ name: 'background.md', sourceId: 'default', directory: false });
    expect(accepted.command).toEqual([]);
    const run = await finished(accepted.id);
    if (run.status !== 'completed') throw new Error(JSON.stringify(run));
    expect(run.status).toBe('completed');
    expect(run.result).toMatchObject({ imported: 1, errors: 0 });
    expect(run.product).toMatchObject({ name: '导入资料', percent: 100, stage: '导入完成' });
    expect(run.product?.material?.page).toMatchObject({ slug: 'background', type: 'note' });
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
    const reader = new ProductTaskRuntime(engine);
    expect((await reader.getRun(accepted.id))?.result).toMatchObject({ imported: 1 });
    expect((await reader.getRun(accepted.id))?.product).toEqual(run.product);
    expect((await reader.listRuns()).some(row => row.id === accepted.id)).toBe(true);
    await reader.close();
  }, 30_000);

  test('大范围扫描保留排序和 Source 过滤，分页读取正文期间可取消', async () => {
    await engine.executeRaw(`INSERT INTO sources(id, name) VALUES ('scan-source', '扫描测试源')`);
    await engine.executeRaw(`INSERT INTO pages(slug, source_id, type, title, compiled_truth, frontmatter)
      SELECT 'scan-' || i, 'scan-source', 'note', '合成扫描页 ' || i, '合成正文', '{}'::jsonb FROM generate_series(1, 205) i`);
    const host = new TaskEngineHost(engine, 0, '', async () => {});
    const filters = { sourceId: 'scan-source', limit: 1000, sort: 'slug' as const };
    const expected = await engine.listPages(filters);
    const actual = await host.dispatch({ type: 'rpc', id: 1, method: 'listPages', args: [filters] }) as typeof expected;
    expect(actual.map(page => page.id)).toEqual(expected.map(page => page.id));
    expect(actual.length).toBe(205);
    expect(await engine.listPageIds({ ...filters, pageIds: [] })).toEqual([]);
    await host.close();
    expect(String(await host.dispatch({ type: 'rpc', id: 2, method: 'listPages', args: [filters] }).catch(error => error))).toContain('任务执行已停止');
  });

  test('到期回收每次最多 50 页或一个 Source，未到期数据保留', async () => {
    await engine.executeRaw(`INSERT INTO sources(id, name) VALUES ('purge-batch', '隔离回收测试')`);
    await engine.executeRaw(`INSERT INTO pages(slug, source_id, type, title, compiled_truth, frontmatter, deleted_at)
      SELECT 'purge-' || i, 'purge-batch', 'note', '合成待回收页', '合成正文', '{}'::jsonb,
        CASE WHEN i <= 103 THEN now() - INTERVAL '73 hours' ELSE now() END FROM generate_series(1, 104) i`);
    const queue = new MinionQueue(engine);
    await queue.add('purge-batch-test', {}, { queue: PRODUCT_TASK_QUEUE });
    const job = await queue.claim('purge-token', 30_000, PRODUCT_TASK_QUEUE, ['purge-batch-test']);
    const host = new TaskEngineHost(engine, job!.id, 'purge-token', async () => {});
    try {
      const result = await host.dispatch({ type: 'rpc', id: 1, method: 'purgeDeletedPages', args: [72] }) as { count: number };
      expect(result.count).toBe(103);
      expect((await engine.executeRaw<{ count: number }>(`SELECT count(*)::int AS count FROM pages WHERE source_id = 'purge-batch'`))[0].count).toBe(1);
      await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, updated_at)
        SELECT 'batch-gc', 'item-' || i, now() - INTERVAL '10 days' FROM generate_series(1, 203) i`);
      await engine.executeRaw(`INSERT INTO context_volunteer_events(source_id, slug, confidence, match_arm, volunteered_at)
        SELECT 'purge-batch', 'seed', 0.8, 'synthetic', now() - INTERVAL '100 days' FROM generate_series(1, 203) i`);
      await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint) VALUES ('batch-gc', 'keep')`);
      expect(await purgeStaleCheckpoints(engine, 7, 100)).toBe(203);
      expect(await purgeStaleVolunteerEvents(engine, 90, 100)).toBe(203);
      expect((await engine.executeRaw(`SELECT * FROM op_checkpoints WHERE op = 'batch-gc' AND fingerprint = 'keep'`)).length).toBe(1);
      await engine.executeRaw(`INSERT INTO sources(id, name, archived, archive_expires_at) VALUES
        ('purge-expired-a', '到期 A', true, now() - INTERVAL '1 hour'),
        ('purge-expired-b', '到期 B', true, now() - INTERVAL '1 hour'),
        ('purge-recoverable', '未到期', true, now() + INTERVAL '1 hour')`);
      expect(await purgeExpiredSources(engine, { batchSize: 1 })).toEqual(['purge-expired-a', 'purge-expired-b']);
      expect((await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = 'purge-recoverable'`))[0].id).toBe('purge-recoverable');
    } finally { await host.close(); await queue.cancelJob(job!.id); }
  });

  test('停止等当前显式事务的数据库调用结束，再自然回滚', async () => {
    const queue = new MinionQueue(engine);
    await queue.add('cancel-transaction-test', {}, { queue: PRODUCT_TASK_QUEUE });
    const job = await queue.claim('natural-token', 30_000, PRODUCT_TASK_QUEUE, ['cancel-transaction-test']);
    const host = new TaskEngineHost(engine, job!.id, 'natural-token', async () => {});
    const scope = await host.dispatch({ type: 'rpc', id: 1, method: 'transaction.open', args: [] }) as number;
    await host.dispatch({ type: 'rpc', id: 2, method: 'setConfig', args: ['natural.rollback', 'not committed'], scope });
    let finished = false;
    const current = host.dispatch({ type: 'rpc', id: 3, method: 'executeRaw', args: ['SELECT pg_sleep(0.15)'], scope }).finally(() => { finished = true; });
    await Bun.sleep(20);
    const closing = host.close();
    expect(finished).toBe(false);
    expect(String(await host.dispatch({ type: 'rpc', id: 4, method: 'setConfig', args: ['natural.next', 'bad'], scope }).catch(error => error))).toContain('任务执行已停止');
    await current;
    await closing;
    expect(finished).toBe(true);
    expect(await engine.getConfig('natural.rollback')).toBeNull();
    expect(await engine.getConfig('natural.next')).toBeNull();
    await queue.cancelJob(job!.id);
  });

  test('快速维护和深度整理阶段直接使用同一核心，执行中数据库仍可查询', async () => {
    const quick = await runtime.submitDream({ preset: 'quick', dryRun: true });
    expect(quick.command).toEqual([]);
    expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
    const quickResult = await finished(quick.id);
    if (quickResult.status !== 'completed') throw new Error(JSON.stringify(quickResult));
    expect(quickResult.status).toBe('completed');
    const deep = await runtime.submitDream({ phase: 'orphans', dryRun: true });
    const report = await finished(deep.id);
    expect(report.command).toEqual([]);
    expect(report.result).toHaveProperty('phases');
    expect(report.status).toBe('completed');
  }, 30_000);

  test('无效文件原样失败，服务数据库和后续任务继续可用', async () => {
    const run = await runtime.submitImport({ path: join(root, 'missing.md'), noEmbed: true });
    const failed = await finished(run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBeTruthy();
    expect(failed.product?.errorReason).toContain('路径');
    expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
    const next = await runtime.submitDream({ phase: 'orphans', dryRun: true });
    expect((await finished(next.id)).status).toBe('completed');
  }, 30_000);

  test('真实快速维护等待模型时，任务阶段与知识库查询仍可读取', async () => {
    configureModels();
    const accepted = await runtime.submitDream({ preset: 'quick', timeoutMs: 15_000 });
    try {
      await modelWaiting();
      await Bun.sleep(1200);
      const read = async () => {
        const run = await runtime.getRun(accepted.id);
        expect(run?.status).toBe('running');
        expect(run?.product?.steps.length).toBe(5);
        expect(run?.product?.stage).toBeTruthy();
        expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
      };
      await Promise.race([read(), Bun.sleep(2000).then(() => { throw new Error('快速维护等待模型时阻塞了任务或知识库读取'); })]);
      await runtime.cancel(accepted.id);
    } finally { release(); configureModels(false); }
  }, 30_000);

  test('等待慢模型时知识可查询，重复点击不重复执行，取消后没有迟到写入', async () => {
    configureModels();
    const path = join(root, 'slow.md');
    writeFileSync(path, '# 慢模型\n\n这份资料使用延迟的合成模型验证数据库并发访问。');
    const accepted = await runtime.submitImport({ path });
    try {
      await modelWaiting();
      expect((await runtime.submitImport({ path })).id).toBe(accepted.id);
      const queuedPath = join(root, 'cancel-queued.md');
      writeFileSync(queuedPath, '# 排队取消\n\n这份资料不应开始导入。');
      const queued = await runtime.submitImport({ path: queuedPath });
      expect((await runtime.cancel(queued.id))?.status).toBe('cancelled');
      expect(await engine.getPage('cancel-queued', { sourceId: 'default' })).toBeNull();
      const started = Date.now();
      expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(1500);
      const cancelled = await runtime.cancel(accepted.id);
      expect(cancelled?.status).toBe('cancelled');
      release();
      await Bun.sleep(150);
      expect(await engine.getPage('slow', { sourceId: 'default' })).toBeNull();
      expect((await finished(accepted.id)).status).toBe('cancelled');
    } finally { release(); configureModels(false); }
  }, 30_000);

  test('用户编辑页面后，迟到的导入不能覆盖新版本', async () => {
    configureModels();
    const path = join(root, 'edited.md');
    writeFileSync(path, '# 并发编辑\n\n这是准备导入的旧内容。');
    await engine.putPage('edited', { type: 'concept', title: '旧页面', compiled_truth: '初始内容' }, { sourceId: 'default' });
    const accepted = await runtime.submitImport({ path });
    try {
      await modelWaiting();
      await engine.putPage('edited', { type: 'concept', title: '用户的新页面', compiled_truth: '用户刚刚修改的内容', content_hash: 'new-user-content' }, { sourceId: 'default' });
      release();
      const run = await finished(accepted.id);
      expect(run.status).toBe('failed');
      expect(run.error).toContain('在处理期间已改变');
      expect((await engine.getPage('edited', { sourceId: 'default' }))?.compiled_truth).toBe('用户刚刚修改的内容');
    } finally { release(); configureModels(false); }
  }, 30_000);

  test('处理期间模型配置或原始文件发生变化时拒绝提交', async () => {
    for (const target of ['model', 'file']) {
      configureModels();
      const path = join(root, `${target}-change.md`);
      writeFileSync(path, `# ${target} change\n\n合成内容用于验证任务开始后的配置和输入变化。`);
      const accepted = await runtime.submitImport({ path });
      try {
        await modelWaiting();
        if (target === 'model') configureModels(true, 'updated-test');
        else writeFileSync(path, '# 修改后的原始内容\n\n用户已经保存了新的资料，不能写入旧的结果。');
        release();
        const run = await finished(accepted.id);
        expect(run.status).toBe('failed');
        expect(run.error).toContain(target === 'model' ? '模型配置已改变' : '原始文件在处理期间已改变');
        expect(await engine.getPage(`${target}-change`, { sourceId: 'default' })).toBeNull();
      } finally { release(); configureModels(false); }
    }
  }, 45_000);

  test('任务排队不串知识源，同名页面分别保存到各自 Source', async () => {
    const ids = ['task-source-a', 'task-source-b'];
    const tasks = [];
    for (const id of ids) {
      const directory = join(root, id);
      mkdirSync(directory);
      await engine.executeRaw(`INSERT INTO sources(id, name, local_path) VALUES ($1, $1, $2)`, [id, directory]);
      const path = join(directory, 'same.md');
      writeFileSync(path, `# ${id}\n\n这份合成知识只属于 ${id}。`);
      tasks.push(await runtime.submitImport({ path, sourceId: id, noEmbed: true }));
    }
    for (const [index, task] of tasks.entries()) {
      expect(task.product?.material?.sourceId).toBe(ids[index]);
      expect((await finished(task.id)).status).toBe('completed');
    }
    for (const id of ids) expect((await engine.getPage('same', { sourceId: id }))?.compiled_truth).toContain(id);
    expect(await engine.getPage('same', { sourceId: 'default' })).toBeNull();
  }, 30_000);

  test('已删除的页面和已归档的知识源不会被迟到结果恢复', async () => {
    for (const target of ['deleted', 'archived']) {
      configureModels();
      const path = join(root, `${target}.md`);
      writeFileSync(path, `# ${target}\n\n验证处理时用户删除和归档的操作。`);
      if (target === 'deleted') await engine.putPage(target, { type: 'concept', title: target, compiled_truth: '删除前的页面' }, { sourceId: 'default' });
      const accepted = await runtime.submitImport({ path });
      try {
        await modelWaiting();
        if (target === 'deleted') await engine.softDeletePage(target, { sourceId: 'default' });
        else await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = $1`, ['default']);
        release();
        expect((await finished(accepted.id)).status).toBe('failed');
        expect(await engine.getPage(target, { sourceId: 'default' })).toBeNull();
      } finally {
        release();
        await engine.executeRaw(`UPDATE sources SET archived = false WHERE id = $1`, ['default']);
        configureModels(false);
      }
    }
  }, 45_000);

  test('失败目录导入可继续，已确认完成的文件不重新处理', async () => {
    const directory = join(root, 'resume');
    mkdirSync(directory);
    writeFileSync(join(directory, 'good.md'), '# 已完成\n\n这份资料可以成功导入。');
    writeFileSync(join(directory, 'bad.md'), `# Oversize\n\n${'x'.repeat(26 * 1024 * 1024)}`);
    const accepted = await runtime.submitImport({ path: directory, noEmbed: true });
    const initial = await finished(accepted.id);
    expect(initial.status).toBe('failed');
    writeFileSync(join(directory, 'bad.md'), '# 修复后的内容\n\n现在这份资料也可以被处理。');
    const retry = await runtime.retry(accepted.id);
    expect(retry?.id).not.toBe(accepted.id);
    const resumed = await finished(retry!.id);
    expect(resumed.status).toBe('completed');
    expect(resumed.result).toMatchObject({ resumedFiles: 1, imported: 1 });
  }, 30_000);

  test('关闭运行时不自动重跑不确定的模型请求，重启后保留历史', async () => {
    configureModels();
    const path = join(root, 'interrupted.md');
    writeFileSync(path, '# 中断验证\n\n这次合成模型调用等待软件退出。');
    const accepted = await runtime.submitImport({ path });
    try {
      await modelWaiting();
      const count = slowRequests;
      await runtime.close();
      release();
      runtime = new ProductTaskRuntime(engine);
      await runtime.start();
      await Bun.sleep(150);
      expect((await runtime.getRun(accepted.id))?.status).toBe('failed');
      expect(slowRequests).toBe(count);
      expect(await engine.getPage('interrupted', { sourceId: 'default' })).toBeNull();
      expect((await runtime.listRuns()).some(run => run.id === accepted.id)).toBe(true);
    } finally { release(); configureModels(false); }
  }, 30_000);

  test('过期租约、取消和事务回滚阻止失效 Worker 写入', async () => {
    const queue = new MinionQueue(engine);
    await queue.add('task-fence-test', {}, { queue: PRODUCT_TASK_QUEUE });
    const job = await queue.claim('fence-token', 30_000, PRODUCT_TASK_QUEUE, ['task-fence-test']);
    expect(job).not.toBeNull();
    const host = new TaskEngineHost(engine, job!.id, 'fence-token', async () => {});
    const rpc = (method: string, args: unknown[], scope?: number) => host.dispatch({ type: 'rpc', id: 1, method, args, scope });
    try {
      const scope = await rpc('transaction.open', []) as number;
      await rpc('putPage', ['rollback-test', { type: 'concept', title: '回滚', compiled_truth: '不能保存' }, { sourceId: 'default' }], scope);
      let rollbackError: unknown;
      try { await rpc('scope.close', [false], scope); } catch (error) { rollbackError = error; }
      expect(String(rollbackError)).toContain('事务已回滚');
      expect(await engine.getPage('rollback-test', { sourceId: 'default' })).toBeNull();
      await engine.executeRaw(`UPDATE minion_jobs SET lock_token = 'reclaimed-token' WHERE id = $1`, [job!.id]);
      expect(String(await rpc('setConfig', ['test.fence', 'invalid']).catch(error => error))).toContain('执行租约已失效');
      expect(await engine.getConfig('test.fence')).toBeNull();
      await engine.executeRaw(`UPDATE minion_jobs SET lock_token = $1, lock_until = $2::timestamptz WHERE id = $3`, ['fence-token', new Date(Date.now() - 1000), job!.id]);
      expect(String(await rpc('setConfig', ['test.fence', 'expired']).catch(error => error))).toContain('执行租约已失效');
      await queue.cancelJob(job!.id);
      expect(String(await rpc('setConfig', ['test.fence', 'cancelled']).catch(error => error))).toContain('任务已取消');
    } finally { await host.close(); }
  });

  test('关闭任务时等待数据库的事务不能迟到打开或挂住取消', async () => {
    let releaseTransaction!: () => void;
    let transactionStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseTransaction = resolve; });
    const started = new Promise<void>(resolve => { transactionStarted = resolve; });
    const delayedOwner = {
      kind: engine.kind,
      transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => {
        transactionStarted();
        await gate;
        return engine.transaction(fn);
      },
    } as BrainEngine;
    const host = new TaskEngineHost(delayedOwner, 1, 'closed-token', async () => {});
    const opening = host.dispatch({ type: 'rpc', id: 1, method: 'transaction.open', args: [] }).catch(error => error);
    await started;
    const closed = host.close();
    releaseTransaction();
    expect(String(await opening)).toContain('任务执行已停止');
    await closed;
    expect(await engine.executeRaw('SELECT 1 AS available')).toEqual([{ available: 1 }]);
  });
});
