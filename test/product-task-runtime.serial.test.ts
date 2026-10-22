import { expectRejection } from './helpers/await-rejection.ts';
import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test';
import { Worker } from 'node:worker_threads';
import { databaseRequestContext, withDatabaseRequest } from '../src/product/database/request-context.ts';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { withDatabasePriority } from '../src/product/database/priority.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import type { ConsoleRun } from '../src/commands/natural-lang/types.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { reloadLiveGateway } from '../src/core/ai/reload-live-gateway.ts';
import { TaskEngineHost } from '../src/product/tasks/engine-host.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { SyncFileQueue } from '../src/product/tasks/sync-file-queue.ts';
import { PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configPath } from '../src/core/config.ts';
import { purgeExpiredSources } from '../src/core/destructive-guard.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { purgeStaleVolunteerEvents } from '../src/core/context/volunteer-events.ts';
import { importFile } from '../src/core/import-file.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { initializeSourceGit, commitSourceGit } from '../src/core/source-git.ts';

let engine: BrainEngine;
let runtime: ProductTaskRuntime;
let root: string;
const isolatedKeys = ['GBRAIN_HOME', 'PMBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_MODEL', 'PMBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBEDDING_DIMENSIONS'];
const taskDatabaseUrl = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const embeddingDimensions=taskDatabaseUrl?1536:1024;
const originalEnv = Object.fromEntries(isolatedKeys.map(key => [key, process.env[key]]));
let slowRequests = 0;
let lastEmbeddingInput: string[] = [];
let releaseModel: (() => void) | null = null;
const releases = new Set<() => void>();
let modelServer: ReturnType<typeof Bun.serve>;

function configureModels(enabled = true, model = 'task-test') {
  writeFileSync(configPath(), JSON.stringify({
    engine: taskDatabaseUrl ? 'postgres' : 'pglite', embedding_model: `custom-openai:${model}`, embedding_dimensions: embeddingDimensions,
    custom_openai_api_key: 'task-test-only', provider_base_urls: { 'custom-openai': modelServer.url.origin + '/v1' },
    model_usage: { embedding_enabled: enabled, generative_enabled: false },
    desktop: { knowledge_directory: root,model_services:[{id:'task-test',provider:'custom-openai',name:'本地验收模型',baseUrl:modelServer.url.origin+'/v1',apiKey:'task-test-only',enabled:true,models:[{id:model,name:model,group:'test',kind:'embedding',capabilities:[],inputPriceCny:0,outputPriceCny:0,pricingSource:'manual'}]}] },
  }));
}

test('隔夜继续按本次领取计时，首次时间和累计费用保留，真正超时仍会终止', async () => {
  const queue = new MinionQueue(engine);
  const files = new SyncFileQueue(engine);
  const name = 'resume-timing-test';
  const timeout = 6 * 60 * 60 * 1000;
  const added = await queue.add(name, { taskBudget: { spentCny: 0.6 }, receipts: ['saved'] }, { queue: name, timeout_ms: timeout });
  await engine.executeRaw("UPDATE minion_jobs SET status='paused',started_at=now()-interval '13 hours' WHERE id=$1", [added.id]);
  const original = (await queue.getJob(added.id))!.started_at;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await files.resume(added.id);
      const claimed = await queue.claim(`timing-${attempt}`, 30000, name, [name]);
      expect(claimed?.id).toBe(added.id);
      expect(claimed?.started_at).toEqual(original);
      expect(claimed!.timeout_at!.getTime()).toBeGreaterThan(Date.now());
      expect((await queue.handleWallClockTimeouts(30000)).some(job => job.id === added.id)).toBe(false);
      const preserved = await queue.getJob(added.id);
      expect(preserved?.status).toBe('active');
      expect(preserved?.data).toMatchObject({ taskBudget: { spentCny: 0.6 }, receipts: ['saved'] });
    }
    await engine.executeRaw("UPDATE minion_jobs SET timeout_at=now()-interval '7 hours' WHERE id=$1", [added.id]);
    expect((await queue.handleWallClockTimeouts(30000)).some(job => job.id === added.id)).toBe(true);
    expect((await queue.getJob(added.id))?.error_text).toBe('wall-clock timeout exceeded');
  } finally { await queue.cancelJob(added.id); }
});

async function modelWaiting(timeoutMs=15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!releaseModel && Date.now() < deadline) await Bun.sleep(30);
  if (!releaseModel) throw new Error(JSON.stringify(await runtime.listRuns()));
}

function release() { for (const finish of releases) finish(); releases.clear(); releaseModel = null; }

async function settleOptimize() {
  release();
  for (let attempt = 0; attempt < 40; attempt++) {
    const runs = await runtime.listRuns().catch(() => [] as ConsoleRun[]);
    const live = runs.filter(row => row.searchOptimize && ['queued', 'running'].includes(row.status));
    if (!live.length) break;
    release();
    await Promise.all(live.map(run => runtime.cancel(run.id).catch(() => undefined)));
    release();
    await Bun.sleep(50);
  }
  await engine.setConfig('pmbrain.search_optimize', JSON.stringify({ paused: false, done: 0, items: [], authorized: [] }));
  await engine.executeRaw(`UPDATE minion_jobs SET status='cancelled', idempotency_key=NULL, lock_token=NULL, lock_until=NULL,
    finished_at=COALESCE(finished_at, now()), updated_at=now()
    WHERE idempotency_key=$1 AND status NOT IN ('active','waiting','delayed','waiting-children')`, ['search-optimize:active']);
}

async function finished(id: string, timeoutMs = 25_000): Promise<ConsoleRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runtime.getRun(id);
    if (run && !['running', 'queued'].includes(run.status)) return run;
    await Bun.sleep(30);
  }
  throw new Error(`Task ${id} did not finish: ${JSON.stringify(await runtime.getRun(id))}`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-task-test-'));
  for (const key of isolatedKeys) delete process.env[key];
  process.env.GBRAIN_HOME = root;
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  modelServer = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { input?: string[] };
    lastEmbeddingInput = Array.isArray(body.input) ? body.input : [];
    slowRequests++;
    await new Promise<void>(resolve => {
      const finish = () => { releases.delete(finish); resolve(); };
      releases.add(finish); releaseModel = finish;
    });
    const input = Array.isArray(body.input) ? body.input : [];
    return Response.json({ object: 'list', data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: embeddingDimensions }, (_, i) => i === 0 ? 1 : 0) })), model: 'task-test', usage: { prompt_tokens: 2, total_tokens: 2 } });
  } });
  configureModels(false);
  configureGateway({ embedding_model: 'custom-openai:task-test', embedding_dimensions: embeddingDimensions, env: {} });
  if (taskDatabaseUrl) assertSafeE2eDatabaseUrl(taskDatabaseUrl);
  engine = taskDatabaseUrl ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(taskDatabaseUrl ? { database_url: taskDatabaseUrl } : {});
  await engine.initSchema();
  if(taskDatabaseUrl){await resetPgliteState(engine as any);await engine.setConfig('version','135');await engine.setConfig('pmbrain.schema.version','135');}
  initializeSourceGit(root);
  writeFileSync(join(root, 'initial.txt'), '任务验收初始版本');
  commitSourceGit(root, 'isolated task fixture');
  await engine.executeRaw("UPDATE sources SET config=config-'remote_url',local_path=$1 WHERE id='default'", [root]);
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
  test('连续快速维护复用执行线程，内存不随任务次数持续增长，关闭后释放空闲线程',async()=>{
    configureModels(false);
    const first=await runtime.submitDream({preset:'quick',dryRun:true});
    expect((await finished(first.id)).status).toBe('completed');
    const pool=(runtime as unknown as {idleMaintenanceThreads:import('node:worker_threads').Worker[]}).idleMaintenanceThreads;
    expect(pool).toHaveLength(1);
    const thread=pool[0];
    const baseline=process.memoryUsage().rss;
    for(let index=0;index<30;index++){
      const next=await runtime.submitDream({preset:'quick',dryRun:true});
      expect((await finished(next.id)).status).toBe('completed');
      expect(pool).toHaveLength(1);
      expect(pool[0]).toBe(thread);
    }
    expect(process.memoryUsage().rss-baseline).toBeLessThan(512*1024*1024);
    const deep=await runtime.submitDream({phase:'backlinks',dryRun:true});
    expect((await finished(deep.id)).status).toBe('completed');
    expect(pool).toHaveLength(1);expect(pool[0]).toBe(thread);
    const config=JSON.parse(readFileSync(configPath(),'utf8'));
    config.model_usage.generative_enabled=true;
    writeFileSync(configPath(),JSON.stringify(config));
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2',[root,'default']);
    for(let index=0;index<3;index++){
      await runtime.adjustResourcePressure(index===1);
      const full=await runtime.submitDream({preset:'full',dryRun:true,sourceId:'default'});
      const done=await finished(full.id);
      expect(done.status).toBe('completed');
      const phases=(done.result as {phases:{phase:string;status:string}[]}).phases;
      expect(phases.some(row=>row.phase==='backlinks')).toBe(true);
      expect(phases.some(row=>row.phase==='embed')).toBe(true);
      expect(phases.filter(row=>row.status==='fail')).toEqual([]);
      expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
    }
    configureModels(false);
    await runtime.adjustResourcePressure(true);
    expect(pool).toHaveLength(0);
    for(let index=0;index<3;index++){
      const next=await runtime.submitDream({preset:'quick',dryRun:true});
      expect((await finished(next.id)).status).toBe('completed');
      expect(pool).toHaveLength(0);
      expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
    }
    await runtime.adjustResourcePressure(false);
    console.log('快速维护线程内存验收',JSON.stringify({runs:31,baselineRss:baseline,finalRss:process.memoryUsage().rss,threads:pool.length}));
    await runtime.close();
    expect(pool).toHaveLength(0);
    runtime=new ProductTaskRuntime(engine);await runtime.start();
  },120000);

  test('旧快速维护继续原任务，跳过完整知识源，接着同步第二个源', async () => {
    configureModels(false);
    const first=join(root,'resume-first');const second=join(root,'resume-second');mkdirSync(first);mkdirSync(second);
    const file=join(first,'resume-done.md');writeFileSync(file,'# 已完成\n\n已完成源的原内容。');
    await importFile(engine,file,'resume-done.md',{sourceId:'default',noEmbed:true});
    writeFileSync(file,'# 已完成\n\n本轮继续不能重新同步已完成源。');
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2',[first,'default']);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES ($1,$2,$3)',['resume-second','续跑第二源',second]);
    writeFileSync(join(second,'resume-pending.md'),'# 未完成\n\n只继续这个知识源。');
    const queue=new MinionQueue(engine);
    const report={schema_version:'1',status:'partial',timestamp:new Date().toISOString(),duration_ms:0,brain_dir:first,phases:[],totals:{}};
    const checkpoint={phases:{},reports:{default:report}};
    const job=await queue.add('pmbrain-product-task',{kind:'dream_quick',trigger:'manual',task:{type:'dream',input:{preset:'quick',allSources:true,checkpoint}}},
      {queue:'resume-held',timeout_ms:3600000});
    await engine.executeRaw("UPDATE minion_jobs SET queue=$2,status='paused' WHERE id=$1",[job.id,PRODUCT_TASK_QUEUE]);
    const resumed=await runtime.retry(`task-${job.id}`);
    expect(resumed?.id).toBe(`task-${job.id}`);
    const modelTimer=setInterval(release,20);
    try{
      const done=await finished(resumed!.id,45_000);
      expect(done.status).toBe('completed');
      expect((await engine.getPage('resume-done',{sourceId:'default'}))?.compiled_truth).toContain('已完成源的原内容');
      expect(await engine.getPage('resume-pending',{sourceId:'resume-second'})).not.toBeNull();
      expect(done.product?.scope?.index).toBe(1);
      expect(done.product?.syncScan?.scanned).toBe(1);
      const stored=(await queue.getJob(job.id))!.data.task as any;
      expect(stored.input.checkpoint.reports.default).toEqual(report);
    }finally{
      clearInterval(modelTimer);release();
      const current=await runtime.getRun(`task-${job.id}`).catch(()=>null);
      if(current && ['running','queued'].includes(current.status)){release();await runtime.cancel(current.id).catch(()=>{});release();}
      await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id=$1",['resume-second']).catch(()=>{});
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2',[root,'default']).catch(()=>{});
    }
  },60000);
  test('两个导入先入库，只产生一个搜索优化任务，停止不删除已入库资料', async () => {
    await settleOptimize();
    configureModels();
    const previous = slowRequests;
    let embedId = '';
    try {
      const accepted: ConsoleRun[] = [];
      for (const name of ['parallel-a', 'parallel-b']) {
        const path = join(root, `${name}.md`);
        writeFileSync(path, `# ${name}\n\n合成资料验证非数据库阶段并行。`);
        accepted.push(await runtime.submitImport({ path }));
      }
      const deadline = Date.now() + 20_000;
      let embed: ConsoleRun | undefined;
      while (Date.now() < deadline) {
        const runs = await runtime.listRuns();
        const importsDone = accepted.every(row => {
          const current = runs.find(item => item.id === row.id);
          return !!current && !['running', 'queued'].includes(current.status);
        });
        const optimizers = runs.filter(row => row.searchOptimize && row.status === 'running');
        embed = optimizers[0];
        if (importsDone && optimizers.length === 1 && slowRequests >= previous + 1
          && await engine.getPage('parallel-a', { sourceId: 'default' })
          && await engine.getPage('parallel-b', { sourceId: 'default' })) break;
        await Bun.sleep(30);
      }
      expect(slowRequests).toBe(previous + 1);
      expect(embed?.searchOptimize).toBe(true);
      embedId = embed!.id;
      expect((await runtime.listRuns()).filter(row => row.searchOptimize && ['queued', 'running'].includes(row.status))).toHaveLength(1);
      expect(await engine.getPage('parallel-a', { sourceId: 'default' })).not.toBeNull();
      expect(await engine.getPage('parallel-b', { sourceId: 'default' })).not.toBeNull();
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
        expect((await runtime.requestCancel(embed!.id))?.error).toContain('正在停止');
        expect((await runtime.listRuns()).find(row => row.id === embed!.id)?.status).toBe('running');
        expect(performance.now() - now).toBeLessThan(1000);
      } finally { unlock(); await busy; }
      expect(await engine.getConfig('stop.batch')).toBe('committed naturally');
      release();
      expect((await finished(embed!.id)).status).toBe('cancelled');
      expect(slowRequests).toBe(previous + 1);
      const second = await engine.getChunks('parallel-b', { sourceId: 'default' });
      expect(second.length).toBeGreaterThan(0);
      expect(second.every(chunk => !chunk.embedded_at)).toBe(true);
      expect(await engine.getPage('parallel-a', { sourceId: 'default' })).not.toBeNull();
      expect(await engine.getPage('parallel-b', { sourceId: 'default' })).not.toBeNull();
    } finally {
      release();
      if (embedId) await runtime.cancel(embedId).catch(() => undefined);
      await settleOptimize();
      configureModels(false);
    }
  }, 45_000);

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
    expect(run.result).not.toMatchObject({ vectorsPending: true });
    expect((await runtime.listRuns()).some(row => row.kind === 'embed_stale' && ['queued', 'running'].includes(row.status))).toBe(false);
    expect(run.product).toMatchObject({ name: '导入资料', percent: 100, stage: '原文已入库，实体模型未配置' });
    expect(run.result).toMatchObject({knowledgeStatus:'model_unavailable'});
    expect(run.product?.material?.page).toMatchObject({ slug: 'background', type: 'note' });
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
    const reader = new ProductTaskRuntime(engine);
    expect((await reader.getRun(accepted.id))?.result).toMatchObject({ imported: 1 });
    expect((await reader.getRun(accepted.id))?.product).toEqual(run.product);
    expect((await reader.listRuns()).some(row => row.id === accepted.id)).toBe(true);
    await reader.close();
  }, 30_000);

  test('导入先保存文件和切块，向量化在后台继续，不等待向量接口', async () => {
    await settleOptimize();
    configureModels();
    const path = join(root, 'defer-vectors.md');
    writeFileSync(path, '# 后台向量\n\n先入库再向量化。');
    const before = slowRequests;
    const accepted = await runtime.submitImport({ path });
    try {
      const stored = await finished(accepted.id);
      expect(stored.status).toBe('completed');
      expect(stored.result).toMatchObject({ imported: 1, errors: 0, vectorsPending: true });
      expect(stored.product?.stage).toContain('正在后台优化搜索');
      expect(await engine.getPage('defer-vectors', { sourceId: 'default' })).not.toBeNull();
      const pending = await engine.getChunks('defer-vectors', { sourceId: 'default' });
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every(chunk => !chunk.embedded_at)).toBe(true);
      await modelWaiting();
      expect(slowRequests).toBe(before + 1);
      const embed = (await runtime.listRuns()).find(row => row.kind === 'embed_stale' && ['queued', 'running'].includes(row.status));
      expect(embed).toBeTruthy();
      release();
      expect((await finished(embed!.id)).status).toBe('completed');
      expect((await engine.getChunks('defer-vectors', { sourceId: 'default' })).every(chunk => !!chunk.embedded_at)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('先入库再向量化');
    } finally { release(); await settleOptimize(); configureModels(false); }
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
    const scoped=(host as unknown as {scopes:Map<number,{engine:BrainEngine}>}).scopes.get(scope)!.engine;
    const execute=scoped.executeRaw.bind(scoped);
    let entered!:()=>void;
    let releaseQuery!:()=>void;
    const queryEntered=new Promise<void>(resolve=>{entered=resolve;});
    const queryReleased=new Promise<void>(resolve=>{releaseQuery=resolve;});
    scoped.executeRaw=async(sql,params)=>{
      if(sql==='SELECT pg_sleep(0.15)'){entered();await queryReleased;}
      return execute(sql,params);
    };
    let finished = false;
    const current = host.dispatch({ type: 'rpc', id: 3, method: 'executeRaw', args: ['SELECT pg_sleep(0.15)'], scope }).finally(() => { finished = true; });
    await queryEntered;
    const closing = host.close();
    try{
      expect(finished).toBe(false);
      expect(String(await host.dispatch({ type: 'rpc', id: 4, method: 'setConfig', args: ['natural.next', 'bad'], scope }).catch(error => error))).toContain('任务执行已停止');
    }finally{
      releaseQuery();await current;await closing;scoped.executeRaw=execute;
    }
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
    await settleOptimize();
    configureModels();
    writeFileSync(join(root,'quick-model-wait.md'),'# 模型等待验收\n\n这份新资料确保快速维护实际调用延迟模型，验证任务查询和知识库读取。');
    if(!await engine.getPage('background',{sourceId:'default'}))await engine.putPage('background',{type:'note',title:'后台查询验收',compiled_truth:'等待模型时仍可以读取已有知识。',timeline:'',frontmatter:{}},{sourceId:'default'});
    const accepted = await runtime.submitDream({ preset: 'quick', timeoutMs: 60_000 });
    try {
      await modelWaiting(45_000);
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
    } finally { await runtime.cancel(accepted.id);release(); configureModels(false); }
  }, 60_000);

  test('资料入库后向量化等待模型时，知识仍可查询，重复导入不重复调用模型', async () => {
    await settleOptimize();
    configureModels();
    const path = join(root, 'slow.md');
    writeFileSync(path, '# 慢模型\n\n这份资料使用延迟的合成模型验证数据库并发访问。');
    const accepted = await runtime.submitImport({ path });
    try {
      expect((await finished(accepted.id)).status).toBe('completed');
      await modelWaiting();
      const before = slowRequests;
      const again = await runtime.submitImport({ path });
      expect(again.id).not.toBe(accepted.id);
      expect((await finished(again.id)).status).toBe('completed');
      expect(slowRequests).toBe(before);
      const started = Date.now();
      expect((await engine.getPage('slow', { sourceId: 'default' }))?.compiled_truth).toContain('延迟的合成模型');
      expect(await engine.getPage('background', { sourceId: 'default' })).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(1500);
      const embed = (await runtime.listRuns()).find(row => row.kind === 'embed_stale' && row.status === 'running');
      expect(embed).toBeTruthy();
      await runtime.cancel(embed!.id);
      release();
      await finished(embed!.id);
      expect((await engine.getPage('slow', { sourceId: 'default' }))?.compiled_truth).toContain('延迟的合成模型');
    } finally { release(); await settleOptimize(); configureModels(false); }
  }, 30_000);

  test('资料入库后用户修改页面，后台向量化不能覆盖新内容', async () => {
    await settleOptimize();
    configureModels();
    const path = join(root, 'edited.md');
    writeFileSync(path, '# 并发编辑\n\n这是准备导入的旧内容。');
    await engine.putPage('edited', { type: 'concept', title: '旧页面', compiled_truth: '初始内容' }, { sourceId: 'default' });
    const accepted = await runtime.submitImport({ path });
    try {
      expect((await finished(accepted.id)).status).toBe('completed');
      await modelWaiting();
      const embeds = (await runtime.listRuns()).filter(row => row.kind === 'embed_stale' && ['queued', 'running'].includes(row.status));
      await engine.putPage('edited', { type: 'concept', title: '用户的新页面', compiled_truth: '用户刚刚修改的内容', content_hash: 'new-user-content' }, { sourceId: 'default' });
      const embedDeadline = Date.now() + 20_000;
      while (Date.now() < embedDeadline) {
        release();
        const live = (await runtime.listRuns()).filter(row => row.searchOptimize && ['queued', 'running'].includes(row.status));
        if (!live.length) break;
        await Bun.sleep(30);
      }
      expect((await engine.getPage('edited', { sourceId: 'default' }))?.compiled_truth).toBe('用户刚刚修改的内容');
    } finally { release(); await settleOptimize(); configureModels(false); }
  }, 30_000);

  test('向量化期间更换模型会停止向量任务，已入库资料和后改的文件都保留', async () => {
    for (const target of ['model', 'file']) {
      await settleOptimize();
      configureModels();
      const path = join(root, `${target}-change.md`);
      writeFileSync(path, `# ${target} change\n\n合成内容用于验证任务开始后的配置和输入变化。`);
      const accepted = await runtime.submitImport({ path });
      try {
        expect((await finished(accepted.id)).status).toBe('completed');
        await modelWaiting();
        const embed = (await runtime.listRuns()).find(row => row.kind === 'embed_stale' && row.status === 'running');
        expect(embed).toBeTruthy();
        if (target === 'model') configureModels(true, 'updated-test');
        else writeFileSync(path, '# 修改后的原始内容\n\n用户已经保存了新的资料，不能写入旧的结果。');
        release();
        const settled = await finished(embed!.id);
        expect((await engine.getPage(`${target}-change`, { sourceId: 'default' }))?.compiled_truth).toContain('合成内容用于验证');
        if (target === 'model') expect(settled?.error ?? '').toContain('模型配置已改变');
        if (target === 'file') expect(readFileSync(path, 'utf8')).toContain('修改后的原始内容');
      } finally { release(); await settleOptimize(); configureModels(false); }
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

  test('后台向量化不会恢复已删除的页面，也不会重新打开已归档的知识源', async () => {
    for (const target of ['deleted', 'archived']) {
      await settleOptimize();
      configureModels();
      const path = join(root, `${target}.md`);
      writeFileSync(path, `# ${target}\n\n验证处理时用户删除和归档的操作。`);
      if (target === 'deleted') await engine.putPage(target, { type: 'concept', title: target, compiled_truth: '删除前的页面' }, { sourceId: 'default' });
      const accepted = await runtime.submitImport({ path });
      try {
        expect((await finished(accepted.id)).status).toBe('completed');
        await modelWaiting();
        const embeds = (await runtime.listRuns()).filter(row => row.kind === 'embed_stale' && ['queued', 'running'].includes(row.status));
        if (target === 'deleted') await engine.softDeletePage(target, { sourceId: 'default' });
        else await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = $1`, ['default']);
        release();
        for (const embed of embeds) await finished(embed.id);
        if (target === 'deleted') expect(await engine.getPage(target, { sourceId: 'default' })).toBeNull();
        else expect((await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id = $1', ['default']))[0]?.archived).toBe(true);
      } finally {
        release();
        await settleOptimize();
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
    expect(retry?.id).toBe(accepted.id);
    const resumed = await finished(retry!.id);
    expect(resumed.status).toBe('completed');
    expect(resumed.result).toMatchObject({ resumedFiles: 1, imported: 1 });
  }, 30_000);

  test('关闭运行时保留未提交的搜索优化，重启后只继续这一页', async () => {
    await settleOptimize();
    configureModels();
    const path = join(root, 'interrupted.md');
    writeFileSync(path, '# 中断验证\n\n这次合成模型调用等待软件退出。');
    const accepted = await runtime.submitImport({ path });
    try {
      const stored = await finished(accepted.id);
      expect(stored.status).toBe('completed');
      expect(await engine.getPage('interrupted', { sourceId: 'default' })).not.toBeNull();
      await modelWaiting();
      const count = slowRequests;
      await runtime.close();
      expect(slowRequests).toBe(count);
      release();
      runtime = new ProductTaskRuntime(engine);
      await runtime.start();
      await modelWaiting();
      expect(slowRequests).toBe(count + 1);
      const embed = (await runtime.listRuns()).find(row => row.searchOptimize && ['queued', 'running'].includes(row.status));
      expect(embed).toBeTruthy();
      release();
      expect((await finished(embed!.id)).status).toBe('completed');
      expect((await engine.getChunks('interrupted', { sourceId: 'default' })).every(chunk => !!chunk.embedded_at)).toBe(true);
      expect((await runtime.listRuns()).some(run => run.id === accepted.id)).toBe(true);
    } finally { release(); await settleOptimize(); configureModels(false); }
  }, 45_000);

  test('搜索优化可以暂停，新导入只排队，重启不会自行继续', async () => {
    await settleOptimize();
    configureModels();
    const first = join(root, 'optimize-a.md');
    const second = join(root, 'optimize-b.md');
    const keyword = join(root, 'optimize-keyword.md');
    writeFileSync(first, '# 第一份\n\n第一份资料等待优化。');
    writeFileSync(second, '# 第二份\n\n第二份资料等待优化。');
    writeFileSync(keyword, '# 仅关键词\n\n这份资料不进入搜索优化。');
    const accepted = await runtime.submitImport({ path: first });
    try {
      expect((await finished(accepted.id)).product?.stage).toContain('正在后台优化搜索');
      await modelWaiting();
      const embed = (await runtime.listRuns()).find(row => row.searchOptimize && ['queued', 'running'].includes(row.status));
      expect(embed).toBeTruthy();
      expect((await runtime.pauseSearchOptimize(embed!.id))?.id).toBe(embed!.id);
      const queued = await finished((await runtime.submitImport({ path: second })).id);
      expect(queued.product?.stage).toContain('搜索优化已暂停');
      release();
      expect((await finished(embed!.id)).status).toBe('paused');
      expect((await engine.getChunks('optimize-a', { sourceId: 'default' })).every(chunk => !!chunk.embedded_at)).toBe(true);
      expect((await engine.getChunks('optimize-b', { sourceId: 'default' })).every(chunk => !chunk.embedded_at)).toBe(true);
      expect((await finished((await runtime.submitImport({ path: keyword, noEmbed: true })).id)).status).toBe('completed');
      const pending = JSON.parse(await engine.getConfig('pmbrain.search_optimize') ?? '{}') as { items?: Array<{ slug: string }> };
      expect(pending.items?.some(item => item.slug === 'optimize-keyword')).toBe(false);
      expect(pending.items?.some(item => item.slug === 'optimize-b')).toBe(true);
      const count = slowRequests;
      await runtime.close();
      runtime = new ProductTaskRuntime(engine);
      await runtime.start();
      await Bun.sleep(200);
      expect(slowRequests).toBe(count);
      expect((await runtime.getRun(embed!.id))?.status).toBe('paused');
      const continued = await runtime.continueSearchOptimize(embed!.id);
      expect(continued?.id).toBe(embed!.id);
      await modelWaiting();
      expect(lastEmbeddingInput.join('\n')).toContain('第二份');
      expect(lastEmbeddingInput.join('\n')).not.toContain('第一份');
      release();
      expect((await finished(embed!.id)).status).toBe('completed');
      expect((await engine.getChunks('optimize-b', { sourceId: 'default' })).every(chunk => !!chunk.embedded_at)).toBe(true);
    } finally { release(); await settleOptimize(); configureModels(false); }
  }, 45_000);

  test('页面向量按小批提交，暂停后续跑不重复已落库的内容', async () => {
    await settleOptimize();
    configureModels();
    await reloadLiveGateway(engine);
    await engine.putPage('batched-page', { type: 'note', title: '分批', compiled_truth: '占位' }, { sourceId: 'default' });
    await engine.upsertChunks('batched-page', [
      { chunk_index: 0, chunk_text: '已提交的第一段', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: '尚未提交的第二段', chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    let checks = 0;
    try {
      const first = runEmbedCore(engine, {
        slugs: ['batched-page'], sourceId: 'default', quiet: true, providerBatchSize: 1,
        pauseCheck: () => ++checks > 1,
      });
      await modelWaiting();
      expect(lastEmbeddingInput).toEqual(['已提交的第一段']);
      release();
      const partial = await first;
      expect(partial.incomplete).toBe(true);
      expect(partial.committedBatches).toBe(1);
      const chunks = await engine.getChunks('batched-page', { sourceId: 'default' });
      expect(chunks.find(chunk => chunk.chunk_index === 0)?.embedded_at).toBeTruthy();
      expect(chunks.find(chunk => chunk.chunk_index === 1)?.embedded_at).toBeFalsy();
      const second = runEmbedCore(engine, { slugs: ['batched-page'], sourceId: 'default', quiet: true, providerBatchSize: 1 });
      await modelWaiting();
      expect(lastEmbeddingInput).toEqual(['尚未提交的第二段']);
      release();
      expect((await second).incomplete).toBeUndefined();
      expect((await engine.getChunks('batched-page', { sourceId: 'default' })).every(chunk => !!chunk.embedded_at)).toBe(true);
    } finally { release(); await settleOptimize(); configureModels(false); }
  }, 30_000);

  test('整理任务没有填写超时时按 6 小时执行，不会几分钟就被判死', async () => {
    const accepted = await runtime.submitDream({ preset: 'quick', dryRun: true });
    const rows = await engine.executeRaw<{ timeout_ms: string | number }>('SELECT timeout_ms FROM minion_jobs WHERE id = $1', [Number(accepted.id.slice(5))]);
    expect(Number(rows[0]?.timeout_ms)).toBe(6 * 60 * 60 * 1000);
    await runtime.requestCancel(accepted.id);
  });

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
      await rpc('setConfig', ['test.fence', 'kept']);
      expect(await engine.getConfig('test.fence')).toBe('kept');
      const fresh = await engine.executeRaw<{ fresh: boolean }>('SELECT lock_until > now() AS fresh FROM minion_jobs WHERE id = $1', [job!.id]);
      expect(fresh[0]?.fresh).toBe(true);
      await queue.cancelJob(job!.id);
      expect(String(await rpc('setConfig', ['test.fence', 'cancelled']).catch(error => error))).toContain('任务已取消');
    } finally { await host.close(); }
  });

  test('页面写入回滚后同一任务可以重新读取并继续，外部修改仍被保护', async () => {
    const queue = new MinionQueue(engine);
    await queue.add('page-rollback-test', {}, { queue: PRODUCT_TASK_QUEUE });
    const job = await queue.claim('page-rollback', 30_000, PRODUCT_TASK_QUEUE, ['page-rollback-test']);
    const host = new TaskEngineHost(engine, job!.id, 'page-rollback', async () => {});
    const rpc = (method: string, args: unknown[], scope?: number) => host.dispatch({ type: 'rpc', id: 1, method, args, scope });
    const slug = 'projects/page-rollback';
    const page = (body: string) => ({ type: 'project', title: '回滚重试', compiled_truth: body, content_hash: body });
    await engine.putPage(slug, page('original'), { sourceId: 'default' });
    try {
      await rpc('getPage', [slug, { sourceId: 'default' }]);
      const scope = await rpc('transaction.open', []) as number;
      await rpc('putPage', [slug, page('rolled-back'), { sourceId: 'default' }], scope);
      await expectRejection(rpc('scope.close', [false], scope), '事务已回滚');
      expect((await engine.getPage(slug))?.compiled_truth).toBe('original');
      await rpc('getPage', [slug, { sourceId: 'default' }]);
      await rpc('putPage', [slug, page('retried'), { sourceId: 'default' }]);
      expect((await engine.getPage(slug))?.compiled_truth).toBe('retried');
      const outer = await rpc('transaction.open', []) as number;
      await rpc('putPage', [slug, page('outer'), { sourceId: 'default' }], outer);
      const inner = await rpc('transaction.open', [], outer) as number;
      await rpc('putPage', [slug, page('inner'), { sourceId: 'default' }], inner);
      await expectRejection(rpc('scope.close', [false], inner), '事务已回滚');
      await rpc('putPage', [slug, page('after-inner'), { sourceId: 'default' }], outer);
      await rpc('scope.close', [true], outer);
      expect((await engine.getPage(slug))?.compiled_truth).toBe('after-inner');
      const rollbackOuter = await rpc('transaction.open', []) as number;
      const commitInner = await rpc('transaction.open', [], rollbackOuter) as number;
      await rpc('putPage', [slug, page('inner-commit'), { sourceId: 'default' }], commitInner);
      await rpc('scope.close', [true], commitInner);
      await expectRejection(rpc('scope.close', [false], rollbackOuter), '事务已回滚');
      expect((await engine.getPage(slug))?.compiled_truth).toBe('after-inner');
      await rpc('putPage', [slug, page('after-outer-rollback'), { sourceId: 'default' }]);
      expect((await engine.getPage(slug))?.compiled_truth).toBe('after-outer-rollback');
      const create = await rpc('transaction.open', []) as number;
      await rpc('putPage', ['projects/new-rollback', page('new'), { sourceId: 'default' }], create);
      await expectRejection(rpc('scope.close', [false], create), '事务已回滚');
      expect(await engine.getPage('projects/new-rollback')).toBeNull();
      await rpc('putPage', ['projects/new-rollback', page('recreated'), { sourceId: 'default' }]);
      expect((await engine.getPage('projects/new-rollback'))?.compiled_truth).toBe('recreated');
      await engine.putPage(slug, page('external'), { sourceId: 'default' });
      await rpc('getPage', [slug, { sourceId: 'default' }]);
      await expectRejection(rpc('putPage', [slug, page('overwrite'), { sourceId: 'default' }]), '在处理期间已改变');
      expect((await engine.getPage(slug))?.compiled_truth).toBe('external');
    } finally { await host.close(); await queue.cancelJob(job!.id); }
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
  test.skipIf(!taskDatabaseUrl)('Postgres 正在执行的长 SQL 原生取消并回滚，其他连接仍可查询', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('native-sql-cancel', {}, { queue: 'native-sql-cancel' });
    await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='native-cancel',lock_until=now()+interval '1 hour' WHERE id=$1", [job.id]);
    const host = new TaskEngineHost(engine, job.id, 'native-cancel', async () => {});
    const scope = await host.dispatch({ type:'rpc',id:1,method:'transaction.open',args:[] }) as number;
    await host.dispatch({ type:'rpc',id:2,method:'setConfig',args:['native.cancel.rollback','must rollback'],scope });
    const running = host.dispatch({ type:'rpc',id:3,method:'executeRaw',args:['SELECT pg_sleep(60)'],scope });
    void running.catch(() => {});
    const deadline = Date.now()+5000;
    for (;;) {
      const [row] = await engine.executeRaw<{ active:boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query='SELECT pg_sleep(60)' AND state='active') active");
      if (row?.active) break;
      if (Date.now()>deadline) throw new Error('long SQL did not enter PostgreSQL');
      await Bun.sleep(20);
    }
    const started = performance.now();
    host.cancel();
    await expectRejection(running);
    await host.close();
    expect(performance.now()-started).toBeLessThan(3000);
    expect(await engine.getConfig('native.cancel.rollback')).toBeNull();
    expect(await engine.executeRaw('SELECT 1 AS available')).toEqual([{available:1}]);
    await queue.cancelJob(job.id);
  },10000);
  test.skipIf(!taskDatabaseUrl)('Postgres 等待其他连接的锁时可停止，不能提交等待中的事务', async () => {
    const queue=new MinionQueue(engine);
    const job=await queue.add('native-lock-cancel',{}, {queue:'native-lock-cancel'});
    await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='lock-cancel',lock_until=now()+interval '1 hour' WHERE id=$1",[job.id]);
    const host=new TaskEngineHost(engine,job.id,'lock-cancel',async()=>{});
    let release!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),opened=new Promise<void>(resolve=>{ready=resolve;});
    const holder=engine.transaction(async tx=>{await tx.executeRaw('SELECT pg_advisory_xact_lock(1476001)');ready();await gate;});
    try{
      await opened;
      const scope=await host.dispatch({type:'rpc',id:1,method:'transaction.open',args:[]}) as number;
      await host.dispatch({type:'rpc',id:2,method:'setConfig',args:['lock.cancel.rollback','uncommitted'],scope});
      const pending=host.dispatch({type:'rpc',id:3,method:'executeRaw',args:['SELECT pg_advisory_xact_lock(1476001)'],scope});
      const settled=pending.then(()=>null,error=>error);
      for(let attempt=0;;attempt++){
        const [row]=await engine.executeRaw<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query='SELECT pg_advisory_xact_lock(1476001)' AND wait_event_type='Lock') waiting");
        if(row?.waiting)break;
        if(attempt>100)throw new Error('Postgres fixture did not wait for its advisory lock');
        await Bun.sleep(20);
      }
      const start=performance.now();host.cancel();expect(await settled).toBeInstanceOf(Error);await host.close();
      expect(performance.now()-start).toBeLessThan(3000);
      expect(await engine.getConfig('lock.cancel.rollback')).toBeNull();
    }finally{host.cancel();release();await holder;await host.close();await queue.cancelJob(job.id);}
  },15000);
  test.skipIf(!taskDatabaseUrl)('Postgres 在途连接断开后保留原生失败并回滚，不会把写入当完成',async()=>{
    const queue=new MinionQueue(engine);
    const job=await queue.add('native-disconnect',{}, {queue:'native-disconnect'});
    await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='disconnect',lock_until=now()+interval '1 hour' WHERE id=$1",[job.id]);
    const host=new TaskEngineHost(engine,job.id,'disconnect',async()=>{});
    try{
      const scope=await host.dispatch({type:'rpc',id:1,method:'transaction.open',args:[]}) as number;
      const rows=await host.dispatch({type:'rpc',id:2,method:'executeRaw',args:['SELECT pg_backend_pid() pid'],scope}) as Array<{pid:number}>;
      await host.dispatch({type:'rpc',id:3,method:'setConfig',args:['disconnect.rollback','uncommitted'],scope});
      const pending=host.dispatch({type:'rpc',id:4,method:'executeRaw',args:['SELECT pg_sleep(60)'],scope});
      const settled=pending.then(()=>null,error=>error);
      for(let attempt=0;;attempt++){
        const [row]=await engine.executeRaw<{active:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND query='SELECT pg_sleep(60)' AND state='active') active",[rows[0]!.pid]);
        if(row?.active)break;
        if(attempt>100)throw new Error('Postgres fixture did not enter its long query');
        await Bun.sleep(20);
      }
      await engine.executeRaw('SELECT pg_terminate_backend($1)',[rows[0]!.pid]);
      expect(await settled).toBeInstanceOf(Error);await host.close();
      expect(await engine.getConfig('disconnect.rollback')).toBeNull();
      expect(await engine.executeRaw('SELECT 1 AS available')).toEqual([{available:1}]);
    }finally{host.cancel();await host.close();await queue.cancelJob(job.id);}
  },15000);
  test('执行线程提前退出后，资源采样和停止不影响服务，原任务可以重试', async () => {
    configureModels();
    const path=join(root,'thread-exit.md');
    writeFileSync(path,'# 线程提前退出\n\n停止与资源检查必须保留服务和原任务。');
    let thread:Worker|undefined;
    let ownerId=0;
    let releaseClose!:()=>void;
    let enteredClose!:()=>void;
    const closing=new Promise<void>(resolve=>{enteredClose=resolve;});
    const gate=new Promise<void>(resolve=>{releaseClose=resolve;});
    const post=Worker.prototype.postMessage;
    const close=TaskEngineHost.prototype.close;
    const postSpy=spyOn(Worker.prototype,'postMessage').mockImplementation(function(this:Worker,message:any,...args:any[]){
      if(message.type==='start'&&message.task?.type==='embed'){thread=this;ownerId=message.ownerJobId;}
      return post.call(this,message,...args as []);
    });
    const closeSpy=spyOn(TaskEngineHost.prototype,'close').mockImplementation(async function(this:TaskEngineHost){
      if((this as unknown as {jobId:number}).jobId===ownerId){enteredClose();await gate;}
      return close.call(this);
    });
    let accepted:ConsoleRun|undefined;
    try {
      accepted=await runtime.submitImport({path});
      await modelWaiting();
      const historySpy=spyOn(MinionQueue.prototype,'getJobs');
      try {
        expect((await runtime.getRun(accepted.id))?.status).toBe('completed');
        expect((await runtime.getRun(`task-${ownerId}`))?.status).toBe('running');
        expect(historySpy).not.toHaveBeenCalled();
      } finally {historySpy.mockRestore();}
      expect(thread).toBeDefined();
      await thread!.terminate();
      await closing;
      await expect(runtime.adjustResourcePressure(false)).resolves.toBeUndefined();
      expect((await runtime.requestCancel(`task-${ownerId}`,'任务 Worker 意外退出'))?.id).toBe(`task-${ownerId}`);
      expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
    } finally {
      releaseClose();postSpy.mockRestore();closeSpy.mockRestore();release();configureModels(false);
      if(ownerId)await runtime.cancel(`task-${ownerId}`);
    }
    const resumed=await runtime.retry(`task-${ownerId}`);
    expect(resumed?.id).toBe(`task-${ownerId}`);
    const modelTimer=setInterval(release,20);
    try {expect((await finished(`task-${ownerId}`)).status).toBe('completed');}
    finally {clearInterval(modelTimer);release();await runtime.cancel(`task-${ownerId}`);}
    expect((await engine.getPage('thread-exit'))?.compiled_truth).toContain('保留服务和原任务');
    expect(readFileSync(path,'utf8')).toContain('保留服务和原任务');
  },40000);

  test('空闲线程退出后，新维护任务使用存活线程完成',async()=>{
    configureModels(false);
    const first=await runtime.submitDream({preset:'quick',dryRun:true});
    expect((await finished(first.id)).status).toBe('completed');
    const pool=(runtime as unknown as {idleMaintenanceThreads:Worker[]}).idleMaintenanceThreads;
    expect(pool).toHaveLength(1);
    const exited=pool[0];await exited.terminate();
    const next=await runtime.submitDream({preset:'quick',dryRun:true});
    expect((await finished(next.id)).status).toBe('completed');
    expect(pool).toHaveLength(1);expect(pool[0]).not.toBe(exited);
    expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
  },40000);

  test('存活线程发送失败保留原始错误，服务和原任务重试仍可用',async()=>{
    configureModels(false);
    const path=join(root,'thread-send-failure.md');
    writeFileSync(path,'# 消息失败\n\n线程消息发送失败不能伪装为任务完成。');
    const post=Worker.prototype.postMessage;
    const postSpy=spyOn(Worker.prototype,'postMessage').mockImplementation(function(this:Worker,message:any,...args:any[]){
      if(message.type==='start'&&message.task?.input?.path===path)throw new Error('isolated worker send failure');
      return post.call(this,message,...args as []);
    });
    let accepted:ConsoleRun|undefined;
    try {
      accepted=await runtime.submitImport({path,noEmbed:true});
      const failed=await finished(accepted.id);
      expect(failed.status).toBe('failed');expect(failed.error).toContain('isolated worker send failure');
      expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
    } finally {postSpy.mockRestore();}
    expect((await runtime.retry(accepted!.id))?.id).toBe(accepted!.id);
    expect((await finished(accepted!.id)).status).toBe('completed');
    expect((await engine.getPage('thread-send-failure'))?.compiled_truth).toContain('不能伪装');
  },30000);

  test('数据库分块写入卡住超时后服务恢复，保留已提交资料并继续原任务', async () => {
    configureModels(false);
    if(!taskDatabaseUrl){
      await runtime.close();await engine.disconnect();
      engine=new WorkerPgliteEngine() as unknown as BrainEngine;
      await engine.connect({database_path:join(root,'.pmbrain','timeout-test.pglite')});await engine.initSchema();
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2',[root,'default']);
      runtime=new ProductTaskRuntime(engine);await runtime.start();
    }
    const path=join(root,'write-timeout.md');
    writeFileSync(path,'# 写入超时\n\n失败后继续原任务，不丢失已经提交的其他资料。');
    await engine.putPage('timeout-kept',{type:'note',title:'已提交资料',compiled_truth:'已完成内容必须保留'});
    const dispatch=TaskEngineHost.prototype.dispatch;
    let injected=false;
    const dispatchSpy=spyOn(TaskEngineHost.prototype,'dispatch').mockImplementation(function(this:TaskEngineHost,message){
      const context=databaseRequestContext();
      if(!injected&&message.method==='upsertChunks'&&message.args[0]==='write-timeout'&&context){
        injected=true;
        return withDatabaseRequest({...context,timeoutMs:150},()=>dispatch.call(this,{...message,method:'executeRaw',args:['DO $$ BEGIN LOOP PERFORM 1; END LOOP; END $$']}));
      }
      return dispatch.call(this,message);
    });
    let accepted:ConsoleRun|undefined;
    try {
      accepted=await runtime.submitImport({path,noEmbed:true});
      const failed=await finished(accepted.id);
      expect(injected).toBe(true);
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('数据库请求超时');
      expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
      expect((await engine.getPage('timeout-kept'))?.compiled_truth).toBe('已完成内容必须保留');
      expect(await engine.getPage('write-timeout')).toBeNull();
    } finally {dispatchSpy.mockRestore();if(accepted)await runtime.cancel(accepted.id);}
    const resumed=await runtime.retry(accepted!.id);
    expect(resumed?.id).toBe(accepted!.id);
    expect((await finished(accepted!.id)).status).toBe('completed');
    expect((await engine.getPage('write-timeout'))?.compiled_truth).toContain('继续原任务');
    expect(readFileSync(path,'utf8')).toContain('继续原任务');
  },60000);

});
