import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ProductTaskRuntime, PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { TaskProgressAdapter } from '../src/product/tasks/progress-adapter.ts';
import { SYNC_FILE_QUEUE } from '../src/product/tasks/sync-file-queue.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { DeepOutputReceipt } from '../src/product/tasks/deep-output-receipt';
import { idleBackground } from './helpers/background-resources';
import { DEEP_ORGANIZE_STAGES, type DeepStageResult } from '../shared/deep-organize-progress';
import { pauseSearchOptimize } from '../src/product/tasks/search-optimize-store';
import { SEARCH_OPTIMIZE_CONFIG } from '../src/product/tasks/search-optimize';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms';
import { runCycle } from '../src/core/cycle';
import { planDeepRelations } from '../src/product/tasks/deep-relation-work';

const database = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const saved = keys.map(key => process.env[key]);
let home: string, engine: BrainEngine;
let modelServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-deep-sync-'));
  keys.forEach(key => delete process.env[key]);
  process.env.PMBRAIN_HOME = home; process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.pmbrain'));
  modelServer = Bun.serve({ port: 0, fetch: () => Response.json({ id: 'isolated-deep', object: 'chat.completion', model: 'isolated-capture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ entities: [], relations: [], no_entities: true }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) });
  writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify({ engine: database ? 'postgres' : 'pglite', custom_openai_api_key: 'isolated-only', provider_base_urls: { 'custom-openai': modelServer.url.origin + '/v1' }, models: { default: 'custom-openai:isolated-capture' }, model_usage: { embedding_enabled: false, generative_enabled: true } }));
  if (database) assertSafeE2eDatabaseUrl(database);
  engine = database ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database ? { database_url: database } : {}); await engine.initSchema();
  await engine.setConfig('pricing.overrides', JSON.stringify({ 'custom-openai:isolated-capture': { input: 1, output: 1 } }));
}, 60000);

afterAll(async () => {
  await engine?.disconnect();
  modelServer?.stop(true);
  keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  if (home) {
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep + 'pmbrain-deep-sync-')) throw new Error('测试目录范围不正确');
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);

async function ended(runtime: ProductTaskRuntime, id: string) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const run = await runtime.getRun(id);
    if (run && !['running', 'queued'].includes(run.status)) return run;
    await Bun.sleep(150);
  }
  throw new Error(JSON.stringify(await runtime.getRun(id)));
}

async function pendingVectors(sourceId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await engine.executeRaw<{ slug: string }>(`SELECT value::jsonb->>'slug' AS slug FROM config
      WHERE key LIKE $1 AND CASE WHEN key LIKE $1 THEN value::jsonb->>'sourceId' END = $2 ORDER BY slug`,
    [`${SEARCH_OPTIMIZE_CONFIG}.pending.%`, sourceId]);
    if (rows.length) return rows.map(row => row.slug);
    await Bun.sleep(100);
  }
  return [];
}

test('深度整理冻结新旧提炼清单，时间用完不调用模型，其他知识源不参与', async () => {
  const sourceId = 'deep-round-quota';
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ($1,'提炼配额验收'),('deep-other','其他知识源')", [sourceId]);
  await engine.transaction(async tx => {
    for (const kind of ['fresh', 'older']) {
      for (let index = 0; index < 42; index++) {
        const slug = `${kind}-${index}`;
        await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug}。${'隔离资料正文用于检验本轮配额和后续处理。'.repeat(32)}` }, { sourceId });
      }
    }
    await tx.putPage('other', { type: 'note', title: '其他来源', compiled_truth: '其他知识源内容。'.repeat(90) }, { sourceId: 'deep-other' });
  });
  const prioritySlugs = Array.from({ length: 42 }, (_, i) => `fresh-${i}`);
  const relations = await planDeepRelations(engine, sourceId, prioritySlugs);
  expect(relations.pending).toBe(84);
  expect(relations.slugs.filter(slug => slug.startsWith('older-'))).toHaveLength(6);
  let atomPlan: string[] = [];
  const result = await runPhaseExtractAtoms(engine, {
    sourceId, _transcripts: [], reuseDuplicateSources: true,
    _chat: async () => { throw new Error('到达软预算后仍发起模型请求'); },
    roundWork: { prioritySlugs, deadlineAtMs: 0, saveAtomPlan: async slugs => { atomPlan = slugs; } },
  });
  expect(atomPlan).toHaveLength(50);
  expect(atomPlan.slice(0, 4).every(slug => slug.startsWith('fresh-'))).toBe(true);
  expect(atomPlan.filter(slug => slug.startsWith('older-'))).toHaveLength(10);
  expect(result.details).toMatchObject({ round_fresh_processed: 0, round_older_processed: 0, round_remaining: 84, round_time_reached: true });
  const cycle = await runCycle(engine, {
    brainDir: null, sourceId, phases: ['extract_atoms'], forcePackPhases: ['extract_atoms'],
    roundWork: { prioritySlugs, deadlineAtMs: 0, atomPlan },
  });
  expect(cycle.phases).toMatchObject([{ phase: 'extract_atoms', status: 'warn', details: { round_time_reached: true } }]);
  const firstFresh = atomPlan.find(slug => slug.startsWith('fresh-'))!;
  const firstOlder = atomPlan.find(slug => slug.startsWith('older-'))!;
  const window = { prioritySlugs, atomPlan: [firstFresh, firstOlder], deadlineAtMs: Date.now() + 30_000 };
  const chat = async () => ({
    text: '[]', blocks: [], stopReason: 'end' as const,
    usage: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'custom-openai:isolated-capture', providerId: 'custom-openai',
  });
  const first = await runPhaseExtractAtoms(engine, {
    sourceId, _transcripts: [], reuseDuplicateSources: true, roundWork: window,
    _chat: async () => { window.deadlineAtMs = 0; return chat(); },
  });
  expect(first.details).toMatchObject({ round_fresh_processed: 1, round_older_processed: 0, round_remaining: 83, round_time_reached: true });
  const resumed = await runPhaseExtractAtoms(engine, {
    sourceId, _transcripts: [], reuseDuplicateSources: true,
    roundWork: { ...window, deadlineAtMs: Date.now() + 30_000 }, _chat: chat,
  });
  expect(resumed.details).toMatchObject({ round_fresh_processed: 0, round_older_processed: 1, round_remaining: 82 });
}, 120000);

test('快速维护后深度整理只处理增量，连续运行不重新排队未变的普通文档', async () => {
  const repo = join(home, 'reuse-source'); mkdirSync(repo);
  for (let index = 0; index < 4; index++) writeFileSync(join(repo, `note-${index}.md`), `# 增量资料 ${index}\n\n保持已导入资料，只有文件变化才需要重新导入。`);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-reuse','同步复用验收',$1,'{}'::jsonb)", [repo]);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  try {
    const quick = await ended(runtime, (await runtime.submitDream({ preset: 'quick', sourceId: 'deep-reuse' })).id);
    expect(quick.status, JSON.stringify(quick)).toBe('completed');
    const first = await ended(runtime, (await runtime.submitDream({ preset: 'full', sourceId: 'deep-reuse', maxPages: 1 })).id);
    expect(first.product?.deep?.scan.unchanged, JSON.stringify(first.product)).toBe(4);
    expect((await runtime.files(first.id))?.rows ?? []).toHaveLength(0);
    writeFileSync(join(repo, 'note-0.md'), '# 增量资料 0\n\n这里保存了新增内容，其他三份资料保持不变。');
    const second = await ended(runtime, (await runtime.submitDream({ preset: 'full', sourceId: 'deep-reuse', maxPages: 1 })).id);
    expect(second.product?.deep?.scan.unchanged).toBe(3);
    expect((await runtime.files(second.id))?.rows).toHaveLength(1);
    expect((await engine.getPage('note-0', { sourceId: 'deep-reuse' }))?.compiled_truth).toContain('新增内容');
  } finally { await runtime.close(); }
}, 600000);

test('深度整理的同步摘要与文件明细一致，完成检查不等待后台向量', async () => {
  const repo = join(home, 'deep-file-counts'); mkdirSync(repo);
  writeFileSync(join(repo, 'valid.md'), '# 有效资料\n\n文件成功保存。');
  writeFileSync(join(repo, 'broken.md'), '---\nslug: wrong-path\n---\n# 路径不一致\n\n文件应显示失败。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-counts','同步失败计数',$1,'{}'::jsonb)", [repo]);
  await pauseSearchOptimize(engine, true);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  try {
    const run = await ended(runtime, (await runtime.submitDream({ preset: 'full', sourceId: 'deep-counts' })).id);
    const files = await runtime.files(run.id);
    expect(files?.rows).toHaveLength(2);
    expect(run.product?.syncFiles).toMatchObject({ total: 2, completed: 1, failed: 1, remaining: 0 });
    expect(run.product?.deep?.stages.find(stage => stage.id === 'sync')).toMatchObject({ imported: 1, failed: 1, status: 'partial' });
    expect(run.product?.deep?.stages.map(stage => stage.id)).toEqual(DEEP_ORGANIZE_STAGES.map(stage => stage.id));
    expect(run.product?.deep?.stage).toBe('done');
    expect(await pendingVectors('deep-counts')).toEqual(['valid']);
  } finally { await runtime.close(); await pauseSearchOptimize(engine, false); }
}, 300000);

test('深度整理统计在数据库提交之后累计，失败事务不计入新建或关联', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('deep-metrics','成果统计验收')");
  await engine.putPage('concepts/existing', { type: 'concept', title: '已有概念', compiled_truth: '已有内容' }, { sourceId: 'deep-metrics' });
  const receipt = new DeepOutputReceipt('deep-metrics');
  const observed = receipt.observe(engine);
  await observed.transaction(async tx => {
    await tx.putPage('atoms/new', { type: 'atom', title: '新知识', compiled_truth: '有出处的知识' }, { sourceId: 'deep-metrics' });
    await tx.putPage('concepts/existing', { type: 'concept', title: '已有概念', compiled_truth: '维护后的内容' }, { sourceId: 'deep-metrics' });
    await tx.addLinksBatch([{ from_slug: 'atoms/new', to_slug: 'concepts/existing', from_source_id: 'deep-metrics', to_source_id: 'deep-metrics' }]);
  });
  let rollback: unknown;
  try { await observed.transaction(async tx => {
    await tx.putPage('patterns/rollback', { type: 'note', title: '不会保存', compiled_truth: '回滚内容' }, { sourceId: 'deep-metrics' });
    await tx.addLinksBatch([{ from_slug: 'patterns/rollback', to_slug: 'concepts/existing', from_source_id: 'deep-metrics', to_source_id: 'deep-metrics' }]);
    throw new Error('isolated rollback');
  }); } catch (error) { rollback = error; }
  expect(rollback).toBeInstanceOf(Error);
  expect((rollback as Error).message).toBe('isolated rollback');
  expect(receipt.take()).toMatchObject({ knowledge_created: 1, knowledge_maintained: 1, output_links_created: 1 });
  expect(await engine.getPage('patterns/rollback', { sourceId: 'deep-metrics' })).toBeNull();
}, 60000);

test('深度整理的同步超过快照窗口后在同一任务分批完成，并纳入工作区未提交资料', async () => {
  const repo = join(home, 'git-source'); mkdirSync(repo);
  const content = '# 提交资料\n\n分批同步保留原始资料与已提交范围。\n';
  for (const name of ['one.md', 'two.md', 'three.md']) writeFileSync(join(repo, name), content + name);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  writeFileSync(join(repo, 'one.md'), '# 未提交修改\n\n这份修改应随深度整理进入知识库。');
  writeFileSync(join(repo, 'untracked.md'), '# 未提交新资料');
  const original = readFileSync(join(repo, 'one.md'));
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-git','深度同步验收',$1,'{}'::jsonb)", [repo]);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground, snapshotQuotaBytes: Buffer.byteLength(content + 'three.md') * 2 });
  await runtime.start();
  try {
    const run = await runtime.submitDream({ preset: 'full', sourceId: 'deep-git', maxPages: 1 });
    const done = await ended(runtime, run.id);
    expect(done.status, JSON.stringify(done)).toBe('completed');
    expect(done.product?.deep?.log?.filter(entry => entry.stage === 'sync').map(entry => entry.event)).toEqual(['start', 'finish']);
    const files = await runtime.files(run.id);
    expect(files?.rows).toHaveLength(4);
    expect(files?.rows.every(file => file.status === 'completed')).toBe(true);
    expect((await engine.getPage('one', { sourceId: 'deep-git' }))?.compiled_truth).toContain('未提交修改');
    expect((await engine.getPage('untracked', { sourceId: 'deep-git' }))?.compiled_truth).toContain('未提交新资料');
    expect(readFileSync(join(repo, 'one.md'))).toEqual(original);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('untracked.md');
    const snapshots = await engine.executeRaw<{ path: string }>("SELECT data->'task'->'input'->>'path' AS path FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2", [SYNC_FILE_QUEUE, Number(run.id.slice(5))]);
    expect(snapshots.every(file => !existsSync(file.path))).toBe(true);
    expect((await runtime.listRuns()).filter(item => item.kind === 'dream_full' && item.id === run.id)).toHaveLength(1);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue=$1 AND data->>'kind'='dream_capture_entities' AND data->'task'->'input'->>'sourceId'='deep-git'", [PRODUCT_TASK_QUEUE])).toHaveLength(0);
  } finally { await runtime.close(); }
}, 300000);

test('深度整理同步中断后继续原任务，已完成同步阶段之后的模型工作不自动重跑', async () => {
  const repo = join(home, 'resume-source'); mkdirSync(repo); writeFileSync(join(repo, 'resume.md'), '# 继续资料\n\n保持同一个任务。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-resume','深度续跑验收',$1,'{}'::jsonb)", [repo]);
  const queue = new MinionQueue(engine);
  const paused = await queue.add('pmbrain-product-task', { kind: 'dream_sync', fileSession: true, task: { type: 'dream', input: { phase: 'sync', sourceId: 'deep-resume', checkpoint: { phases: {}, reports: {} } } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='paused',attempts_started=1 WHERE id=$1", [paused.id]);
  const uncertain = await queue.add('pmbrain-product-task', { kind: 'dream_full', fileSession: true, task: { type: 'dream', input: { preset: 'full', sourceId: 'deep-resume', checkpoint: { phases: { 'deep-resume': [{ phase: 'sync', status: 'ok', summary: '完成同步', duration_ms: 1, details: {} }] }, reports: {} } } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='old-service',lock_until=now()-interval '1 minute' WHERE id=$1", [uncertain.id]);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  try {
    expect((await queue.getJob(uncertain.id))?.status).toBe('paused');
    const retried = await runtime.retry(`task-${paused.id}`);
    expect(retried?.id).toBe(`task-${paused.id}`);
    expect((await ended(runtime, retried!.id)).status).toBe('completed');
    expect((await queue.getJob(uncertain.id))?.status).toBe('paused');
  } finally { await runtime.close(); }
}, 300000);

test('深度整理续跑保留已结束阶段和固定同步范围，只累计当前阶段的实际执行', async () => {
  const repo = join(home, 'sealed-deep-source');
  mkdirSync(repo);
  writeFileSync(join(repo, 'next-round.md'), '# 下一轮资料\n\n本轮同步已经结束。');
  const sourceId = 'sealed-deep';
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ($1,'已完成阶段验收',$2,'{}'::jsonb)", [sourceId, repo]);
  const queue = new MinionQueue(engine);
  const stoppedAt = Date.now() - 6 * 60 * 60 * 1000;
  const startedAt = new Date(stoppedAt - 20_000).toISOString();
  const stages: DeepStageResult[] = DEEP_ORGANIZE_STAGES.slice(0, -1).map(({ id }) => ({
    id, status: ['check', 'knowledge'].includes(id) ? 'partial' : 'completed', durationMs: 31_000, result: '保留原回执', detail: '',
  }));
  const checkpoint = {
    phases: { [sourceId]: [{ phase: 'extract_atoms', status: 'warn', duration_ms: 31_000, summary: '本轮额度已用完', details: { pages_remaining: 1218 } }] },
    reports: {},
    deepProgress: {
      stage: 'review', stages, scan: { scanned: 1, unchanged: 0, total: 1, incremental: 1, complete: true },
      current: { result: '完成检查', startedAt, elapsedMs: 120_000 },
      log: [{ at: startedAt, stage: 'review', event: 'start' }],
    },
  };
  const job = await queue.add('pmbrain-product-task', { kind: 'dream_full', fileSession: true, task: { type: 'dream', input: { preset: 'full', sourceId, checkpoint } } },
    { queue: PRODUCT_TASK_QUEUE, delay: 86_400_000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='failed',started_at=$2::timestamptz,finished_at=$3::timestamptz WHERE id=$1",
    [job.id, startedAt, new Date(stoppedAt).toISOString()]);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground });
  await runtime.start();
  try {
    const id = `task-${job.id}`;
    expect((await runtime.retry(id))?.id).toBe(id);
    const result = await ended(runtime, id);
    expect(result.status, result.error ?? '').toBe('completed');
    expect(result.product?.deep?.stages.slice(0, -1)).toEqual(stages);
    expect(result.product?.deep?.log?.map(entry => [entry.stage, entry.event])).toEqual([['review', 'start'], ['review', 'finish']]);
    const elapsed = result.product?.deep?.stages.find(stage => stage.id === 'review')?.durationMs ?? 0;
    expect(elapsed).toBeGreaterThanOrEqual(140_000);
    expect(elapsed).toBeLessThan(200_000);
    expect(await engine.getPage('next-round', { sourceId })).toBeNull();
    expect((result.result as { phases?: Array<{ phase: string }> })?.phases?.some(phase => phase.phase === 'extract_atoms')).toBe(true);
  } finally { await runtime.close(); }
}, 300000);

test('深度整理同步文件进度持续可见，不只显示完成了一个步骤', () => {
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['lint', 'sync', 'synthesize']);
  adapter.event({ phase: 'cycle.sync', event: 'start' });
  adapter.event({ phase: 'import.files', event: 'tick', done: 12, total: 529 });
  expect(adapter.view.processed).toBe(12);
  expect(adapter.view.total).toBe(529);
  expect(adapter.view.phasePercent).toBeGreaterThan(0);
});

test('旧任务从索引阶段续跑时保留已写成果并进入完成检查', async () => {
  const repo = join(home, 'legacy-index-source'); mkdirSync(repo);
  writeFileSync(join(repo, 'next-round.md'), '# 留给下一轮\n\n已封存同步。');
  const sourceId = 'legacy-index';
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ($1,'旧索引续跑验收',$2,'{}'::jsonb)", [sourceId, repo]);
  await engine.putPage('atoms/saved', { type: 'atom', title: '已保存', compiled_truth: '续跑前已经保存的知识点。' }, { sourceId });
  await engine.upsertChunks('atoms/saved', [{ chunk_index: 0, chunk_text: '续跑前已经保存的知识点。', chunk_source: 'compiled_truth' }], { sourceId });
  const stages: DeepStageResult[] = DEEP_ORGANIZE_STAGES.slice(0, -1).map(({ id }) => ({
    id, status: 'completed', durationMs: 31_000, result: '保留原回执', detail: '',
  }));
  const checkpoint = {
    phases: { [sourceId]: [{ phase: 'extract_atoms', status: 'ok', duration_ms: 31_000, summary: '已保存', details: { knowledge_created_refs: [JSON.stringify([sourceId, 'atoms/saved'])] } }] },
    reports: {},
    deepProgress: { stage: 'index', stages, scan: { scanned: 0, unchanged: 0, complete: true } },
  };
  const queue = new MinionQueue(engine);
  const job = await queue.add('pmbrain-product-task', { kind: 'dream_full', fileSession: true, task: { type: 'dream', input: { preset: 'full', sourceId, checkpoint } } },
    { queue: PRODUCT_TASK_QUEUE, delay: 86_400_000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='failed',finished_at=now() WHERE id=$1", [job.id]);
  await pauseSearchOptimize(engine, true);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  try {
    const id = `task-${job.id}`;
    expect((await runtime.retry(id))?.id).toBe(id);
    const run = await ended(runtime, id);
    expect(run.product?.deep?.stages.slice(0, -1)).toEqual(stages);
    expect(run.product?.deep?.stages.at(-1)?.id).toBe('review');
    expect(run.product?.deep?.stage).toBe('done');
    expect(await engine.getPage('next-round', { sourceId })).toBeNull();
    expect(await pendingVectors(sourceId)).toEqual(['atoms/saved']);
  } finally { await runtime.close(); await pauseSearchOptimize(engine, false); }
}, 300000);

test('内容阶段用完预算后保留前序回执并正常执行完成检查', async () => {
  const repo = join(home, 'spent-round-source'); mkdirSync(repo);
  const sourceId = 'spent-round';
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ($1,'时间验收',$2,'{}'::jsonb)", [sourceId, repo]);
  const stages: DeepStageResult[] = DEEP_ORGANIZE_STAGES.slice(0, 3).map(({ id }) => ({
    id, status: 'completed', durationMs: id === 'relations' ? 5 * 60_000 : 1000, result: '保留原回执', detail: '',
  }));
  const checkpoint = {
    phases: {}, reports: {}, deepVectorHandoff: true,
    deepProgress: { stage: 'knowledge', stages, scan: { scanned: 0, unchanged: 0, complete: true }, current: { elapsedMs: 15 * 60_000 } },
  };
  const queue = new MinionQueue(engine);
  const job = await queue.add('pmbrain-product-task', { kind: 'dream_full', fileSession: true, task: { type: 'dream', input: { preset: 'full', sourceId, checkpoint } } },
    { queue: PRODUCT_TASK_QUEUE, delay: 86_400_000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='failed',finished_at=now() WHERE id=$1", [job.id]);
  const runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  try {
    const id = `task-${job.id}`;
    expect((await runtime.retry(id))?.id).toBe(id);
    const run = await ended(runtime, id);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(run.product?.deep?.stages.slice(0, 3)).toEqual(stages);
    expect(run.product?.deep?.stages.find(stage => stage.id === 'knowledge')).toMatchObject({ status: 'partial', detail: expect.stringContaining('本阶段时间额度已用完') });
    expect(run.product?.deep?.stages.at(-1)?.id).toBe('review');
    expect(run.product?.deep?.stage).toBe('done');
  } finally { await runtime.close(); }
}, 180000);

test('深度整理大文档分批写库时显示文件与提交进度，完成后内容和分块完整保留', async () => {
  const repo = join(home, 'large-source'); mkdirSync(repo);
  const zip = new JSZip();
  const paragraphs = Array.from({ length: 160 }, (_, index) => `<w:p><w:r><w:t>章节 ${index}：${'资料正文与验收说明。'.repeat(150)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`);
  const path = join(repo, 'large.docx'); writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
  const original = readFileSync(path);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-large','大文档同步验收',$1,'{}'::jsonb)", [repo]);
  const wrap = (owner: BrainEngine): BrainEngine => new Proxy(owner, { get(target, property) {
    if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(wrap(tx)));
    if (property === 'upsertChunks') return async (...args: Parameters<BrainEngine['upsertChunks']>) => { await Bun.sleep(150); return target.upsertChunks(...args); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const runtime = new ProductTaskRuntime(wrap(engine), { background: idleBackground }); await runtime.start();
  try {
    const run = await runtime.submitDream({ preset: 'full', sourceId: 'deep-large', maxPages: 1 });
    let writing = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const current = await runtime.getRun(run.id);
      writing ||= !!current?.product?.activeFiles?.some(file => file.path === 'large.docx' && (file.bodyWritten ?? 0) > 0 && (file.chunksTotal ?? 0) > 100);
      if (current && !['running', 'queued'].includes(current.status)) break;
      await Bun.sleep(50);
    }
    const done = await ended(runtime, run.id);
    expect(done.status, JSON.stringify(done)).toBe('completed');
    expect(writing, JSON.stringify(done.product)).toBe(true);
    const [file] = await engine.executeRaw<{ slug: string }>("SELECT result->>'slug' AS slug FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2", [SYNC_FILE_QUEUE, Number(run.id.slice(5))]);
    expect((await engine.getChunks(file.slug, { sourceId: 'deep-large' })).length).toBeGreaterThan(100);
    expect((await engine.getPage(file.slug, { sourceId: 'deep-large' }))?.compiled_truth).toContain('章节 159');
    expect(readFileSync(path)).toEqual(original);
  } finally { await runtime.close(); }
}, 300000);

test('深度整理停止及服务重启后仍保持停止，确认继续时复用已完成文件与原任务', async () => {
  const repo = join(home, 'stop-source'); mkdirSync(repo);
  for (let index = 0; index < 12; index++) writeFileSync(join(repo, `file-${index}.md`), `# 停止续跑 ${index}\n\n原任务中的资料 ${index}。`);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('deep-stop','停止续跑验收',$1,'{}'::jsonb)", [repo]);
  const wrap = (owner: BrainEngine): BrainEngine => new Proxy(owner, { get(target, property) {
    if (property === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(wrap(tx)));
    if (property === 'upsertChunks') return async (...args: Parameters<BrainEngine['upsertChunks']>) => { await Bun.sleep(200); return target.upsertChunks(...args); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await pauseSearchOptimize(engine, true);
  let runtime = new ProductTaskRuntime(wrap(engine), { background: idleBackground }); await runtime.start();
  let id = '';
  try {
    id = (await runtime.submitDream({ preset: 'full', sourceId: 'deep-stop', maxPages: 1 })).id;
    const scanDeadline = Date.now() + 40000;
    while (Date.now() < scanDeadline) {
      if (((await runtime.getRun(id))?.product?.deep?.scan.scanned ?? 0) > 0) break;
      await Bun.sleep(50);
    }
    expect((await runtime.getRun(id))?.product?.deep?.scan.scanned ?? 0).toBeGreaterThan(0);
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if ((await runtime.getRun(id))?.product?.syncFiles?.completed) break;
      await Bun.sleep(30);
    }
    expect((await runtime.cancel(id))?.status).toBe('cancelled');
    const [before] = await engine.executeRaw<{ count: number }>("SELECT count(*)::int AS count FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2 AND result->>'status'='imported'", [SYNC_FILE_QUEUE, Number(id.slice(5))]);
    expect(before.count).toBeGreaterThan(0); expect(before.count).toBeLessThan(12);
    await runtime.close(); runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
    expect((await runtime.getRun(id))?.status).toBe('cancelled');
    const pending = await pendingVectors('deep-stop');
    expect(pending).toHaveLength(before.count);
    expect(pending.every(slug => slug.startsWith('file-'))).toBe(true);
    expect((await runtime.retry(id))?.id).toBe(id);
    expect((await ended(runtime, id)).status).toBe('completed');
    const files = await runtime.files(id);
    expect(files?.rows).toHaveLength(12); expect(files?.rows.every(file => file.status === 'completed')).toBe(true);
  } finally { await runtime.close(); await pauseSearchOptimize(engine, false); }
}, 600000);
