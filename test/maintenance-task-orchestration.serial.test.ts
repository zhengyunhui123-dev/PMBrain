import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ProductTaskRuntime, PRODUCT_TASK_QUEUE } from '../src/product/tasks/runtime.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { enqueueImportedEntityCapture } from '../src/core/pmbrain-adapters/imported-entity-capture.ts';
import { requestImportedEntityCapture } from '../src/core/pmbrain-adapters/entity-capture-request.ts';
import { runQuickMaintenance } from '../src/core/quick-maintenance.ts';
import { configPath } from '../src/core/config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { taskRoundCompleted, taskStatus } from '../admin/src/product/task-presentation.ts';
import type { ConsoleRun } from '../shared/contracts/common.ts';

let engine: BrainEngine, runtime: ProductTaskRuntime, root: string, server: ReturnType<typeof Bun.serve>;
let calls = 0, embeddingCalls = 0, hold = false, invalid = false, usageInput = 20, incompleteSlug = '';
const releases = new Set<() => void>();
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const databaseUrl = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const dimensions = databaseUrl ? 1536 : 1024;

async function until(check: () => Promise<boolean>, timeout = 40_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(40); }
  throw new Error(JSON.stringify({ runs: (await runtime.listRuns()).map(run => ({ id: run.id, status: run.status, stage: run.product?.stage, error: run.error })), jobs: await engine.executeRaw('SELECT id,status,queue,error_text,private_queue_owner_job_id FROM minion_jobs ORDER BY id') }));
}

async function finished(id: string, timeout=40_000) {
  await until(async () => !['queued', 'running'].includes((await runtime.getRun(id))?.status ?? 'running'),timeout);
  return (await runtime.getRun(id))!;
}

function release() { hold = false; for (const finish of releases) finish(); releases.clear(); }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-orchestration-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root; mkdirSync(join(root, '.pmbrain'));
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { input?: string | string[]; messages?: unknown[] };
    if (new URL(req.url).pathname.endsWith('/embeddings')) { embeddingCalls++; return Response.json({ object: 'list', data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })), model: 'isolated-embedding', usage: { prompt_tokens: 2, total_tokens: 2 } }); }
    calls++;
    if (hold) await new Promise<void>(finish => releases.add(finish));
    const unfinished=invalid||!!incompleteSlug&&JSON.stringify(body.messages).includes(`资料 slug: ${incompleteSlug}\\n`);
    return Response.json({ id: `chat-${calls}`, object: 'chat.completion', created: 1, model: 'isolated-capture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(unfinished ? { entities: [], relations: [] } : { entities: [], relations: [], no_entities: true }) } }], usage: { prompt_tokens: usageInput, completion_tokens: 10, total_tokens: usageInput + 10 } });
  } });
  writeFileSync(configPath(), JSON.stringify({ engine: databaseUrl ? 'postgres' : 'pglite', custom_openai_api_key: 'isolated-only', embedding_model: 'custom-openai:isolated-embedding', embedding_dimensions: dimensions, provider_base_urls: { 'custom-openai': server.url.origin + '/v1' }, models: { default: 'custom-openai:isolated-capture' }, model_usage: { generative_enabled: true, embedding_enabled: true }, desktop: { knowledge_directory: root } }));
  engine = databaseUrl ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {}); await engine.initSchema();
  await engine.setConfig('pricing.overrides', JSON.stringify({ 'custom-openai:isolated-capture': { input: 1, output: 1 }, 'custom-openai:isolated-embedding': { input: 1, output: 0 } }));
}, 60_000);

beforeEach(async () => {
  calls = 0; embeddingCalls = 0; invalid = false; usageInput = 20; incompleteSlug = ''; release();
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'dream.entity_capture.pending.%'");
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
  await engine.executeRaw("DELETE FROM sources WHERE id<>'default'");
  await engine.setConfig('dream.entity_capture.max_input_tokens', '1000000');
  await engine.setConfig('dream.entity_capture.enabled','true');
  await engine.setConfig('dream.entity_capture.cost_cap_cny','5');
  await engine.executeRaw("DELETE FROM config WHERE key IN ('dream.entity_capture.price.input_cny_per_million','dream.entity_capture.price.output_cny_per_million')");
  await engine.executeRaw("DELETE FROM config WHERE key IN ('dream.entity_capture.document_max_turns','dream.entity_capture.document_max_input_tokens','dream.entity_capture.document_max_output_tokens')");
  runtime = new ProductTaskRuntime(engine); await runtime.start();
}, 30_000);

afterEach(async () => { release(); await runtime?.close(); }, 30_000);
afterAll(async () => {
  release(); await runtime?.close(); await engine?.disconnect(); server?.stop(true);
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('pmbrain-orchestration-')) rmSync(root, { recursive: true, force: true });
}, 60_000);

test('同步多份资料只有一个主任务，快速维护不调用模型或向量服务', async () => {
  const repo = join(root, 'batch'); mkdirSync(repo);
  for (let i = 0; i < 5; i++) writeFileSync(join(repo, `input-${i}.md`), `---\ntitle: 批次资料${i}\ntype: note\n---\n这是用于保存原文及断点检查的测试资料，第${i}份。`);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  const quick = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
  const deep = await runtime.submitDream({ phase: 'backlinks', sourceId: 'default' });
  const done = await finished(quick.id);
  const jobs = await engine.executeRaw<{ kind: string }>("SELECT data->>'kind' AS kind FROM minion_jobs WHERE queue=$1", [PRODUCT_TASK_QUEUE]);
  expect(jobs.filter(job => job.kind === 'dream_capture_entities')).toHaveLength(0);
  expect(jobs.filter(job => job.kind === 'dream_quick')).toHaveLength(1);
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  const phases = (done.result as { phases: Array<{ phase: string; status: string; details: Record<string, any> }> }).phases;
  expect(phases.some(phase => phase.phase === 'capture_entities' || phase.phase === 'embed')).toBe(false);
  const deepDone = await finished(deep.id);
  expect(deepDone.status).toBe('completed');
  expect((deepDone.result as { phases: Array<{ phase: string }> }).phases.some(phase => phase.phase === 'backlinks')).toBe(true);
  expect((deepDone.result as { reason?: string }).reason).not.toBe('cycle_already_running');
  const count = calls;
  const next = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
  expect((await finished(next.id)).status).toBe('completed');
  expect(calls).toBe(count);
  for (let i = 0; i < 5; i++) expect((await engine.getPage(`input-${i}`, { sourceId: 'default' }))?.compiled_truth).toContain(`第${i}份`);
}, 90_000);

test('多 Source 快速维护不领取实体建档请求，保留深度整理所需队列', async () => {
  const first=join(root,'budget-first'),second=join(root,'budget-second');mkdirSync(first);mkdirSync(second);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[first]);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('budget-other','第二个源',$1)",[second]);
  for(const [sourceId,slug,body] of [['default','first','这是第一个知识源的独立原文。'],['budget-other','second','这是第二个知识源的独立原文。']]){
    const page={slug,type:'note',compiled_truth:body,frontmatter:{}};
    await engine.putPage(slug,{...page,title:slug,timeline:''},{sourceId});
    await requestImportedEntityCapture(engine,sourceId,page);
  }
  usageInput = 60000;
  await engine.setConfig('dream.entity_capture.max_input_tokens','1');
  await engine.setConfig('dream.entity_capture.max_output_tokens','1');
  await engine.setConfig('dream.entity_capture.cost_cap_cny','unlimited');
  const quick=await runtime.submitDream({preset:'quick',allSources:true});
  const done=await finished(quick.id,90_000);
  expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
  expect(await engine.getConfig('dream.entity_capture.pending.default')).not.toBeNull();
  const count=calls;
  const next=await runtime.submitDream({preset:'quick',allSources:true});
  expect((await finished(next.id,90_000)).status).toBe('completed');expect(calls).toBe(count);
  expect((await engine.getPage('first',{sourceId:'default'}))?.compiled_truth).toContain('第一个知识源');
  expect((await engine.getPage('second',{sourceId:'budget-other'}))?.compiled_truth).toContain('第二个知识源');
  expect(await engine.getPage('second',{sourceId:'default'})).toBeNull();
  await engine.setConfig('dream.entity_capture.max_input_tokens','1000000');
},180_000);

test('快速维护只连接已有实体，跳过备份和新名字，并在无变化时跳过重复提取', async () => {
  const directory = join(root, 'incremental-quick');
  mkdirSync(join(directory, 'backups'), { recursive: true });
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '张三在星河公司任职。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('companies/example', { type: 'company', title: '星河公司', compiled_truth: '已有公司。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('projects/water', { type: 'project', title: '智慧水务项目', compiled_truth: '已有项目。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.setPageAliases('projects/water', 'default', ['蓝水工程']);
  await engine.putPage('organizations/team', { type: 'organization', title: '星河团队', compiled_truth: '已有组织。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('backups/keep', { type: 'note', title: '旧备份', compiled_truth: '旧备份需要保留。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  writeFileSync(join(directory, 'material.md'), '---\ntitle: 新资料\ntype: note\n---\n张三和星河团队参与星河公司的蓝水工程。新名字李四仅出现在原文中。');
  writeFileSync(join(directory, 'backups', 'keep.md'), '---\ntitle: 修改过的备份\ntype: note\n---\n张三不应从备份建立关系。');
  writeFileSync(join(directory, 'notes.bak.md'), '---\ntitle: 备份文件\ntype: note\n---\n星河公司不应从备份建立关系。');
  const first = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(first.status, JSON.stringify(first.result)).toBe('completed');
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
  const links = await engine.executeRaw<{ slug: string }>("SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug='material'");
  expect(links.map(link => link.slug)).toContain('people/zhang');
  expect(links.map(link => link.slug)).toContain('companies/example');
  expect(links.map(link => link.slug)).toContain('organizations/team');
  expect(links.map(link => link.slug)).toContain('projects/water');
  const entityRelations = await engine.executeRaw<{ link_type: string }>("SELECT l.link_type FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug='people/zhang' AND t.slug='companies/example'");
  expect(entityRelations.map(link => link.link_type)).toContain('works_at');
  expect(await engine.getPage('people/李四', { sourceId: 'default' })).toBeNull();
  expect((await engine.getPage('backups/keep', { sourceId: 'default' }))?.compiled_truth).toBe('旧备份需要保留。');
  expect(await engine.getPage('notes.bak', { sourceId: 'default' })).toBeNull();
  const repeatStarted = performance.now();
  const next = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  console.log(`[quick-unchanged] ${Math.round(performance.now()-repeatStarted)} ms`);
  expect(next.status, JSON.stringify(next.result)).toBe('completed');
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
  const extract = (next.result as { phases: Array<{ phase: string; details: Record<string, unknown> }> }).phases.find(phase => phase.phase === 'extract');
  expect(Number(extract?.details.mentionPagesProcessed ?? 0)).toBe(0);
  expect(Number(extract?.details.relationPagesProcessed ?? 0)).toBe(0);
  await engine.executeRaw("UPDATE page_mention_state SET mention_revision=NULL WHERE page_id IN (SELECT id FROM pages WHERE source_id='default' AND slug='material')");
  const { runMentionPass } = await import('../src/core/mentions/pass.ts');
  expect((await runMentionPass(engine, { sourceId: 'default', slugs: ['material'] })).state).not.toBe('failed');
  const afterDeepPass = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug='material' AND t.slug='projects/water'");
  expect(Number(afterDeepPass[0]?.n)).toBe(1);
  writeFileSync(join(directory, 'material.md'), '---\ntitle: 新资料\ntype: note\n---\n张三和星河团队参与星河公司的工作。');
  const changed = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(changed.status, JSON.stringify(changed.result)).toBe('completed');
  const afterEdit = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug='material' AND t.slug='projects/water'");
  expect(Number(afterEdit[0]?.n)).toBe(0);
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
}, 180_000);

test('待补关联按批次保存并可继续，未完成时不显示全部完成', async () => {
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '已有人员。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  for (let i = 0; i < 7; i++) {
    await engine.putPage(`notes/batch-${i}`, { type: 'note', title: `资料${i}`, compiled_truth: '张三参与工作。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }
  let complete = false;
  for (let round = 0; round < 12; round++) {
    const report = await runQuickMaintenance(engine, { brainDir: null, sourceId: 'default', markdownCatchUpMaxHistorical: 2, byMentionMaxHistorical: 2, byMentionTimeBudgetMs: 30_000 });
    const extract = report.phases.find(phase => phase.phase === 'extract')!;
    expect(Number(extract.details.relationPagesProcessed ?? 0)).toBeLessThanOrEqual(2);
    expect(Number(extract.details.mentionPagesProcessed ?? 0)).toBeLessThanOrEqual(2);
    if (round === 0) {
      expect(report.status).toBe('partial');
      expect(Number(extract.details.remaining)).toBeGreaterThan(0);
    }
    if (report.status === 'ok' || report.status === 'clean') { complete = true; break; }
  }
  expect(complete).toBe(true);
  const links = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug LIKE 'notes/batch-%' AND t.slug='people/zhang'");
  expect(Number(links[0]?.n)).toBe(7);
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
}, 180_000);

test('实体名字表变化不使快速维护扫描未变化资料，深度关联仍可补扫', async () => {
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '已有人员。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('notes/old', { type: 'note', title: '旧资料', compiled_truth: '老张参与工作。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await runQuickMaintenance(engine, { brainDir: null, sourceId: 'default', byMentionTimeBudgetMs: 30_000 });
  const { runMentionPass } = await import('../src/core/mentions/pass.ts');
  await runMentionPass(engine, { sourceId: 'default' });
  await engine.setPageAliases('people/zhang', 'default', ['老张']);
  const quick = await runQuickMaintenance(engine, { brainDir: null, sourceId: 'default', byMentionTimeBudgetMs: 30_000 });
  const extract = quick.phases.find(phase => phase.phase === 'extract')!;
  expect(Number(extract.details.mentionPagesProcessed ?? 0)).toBe(0);
  const countLinks = async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id='default' AND f.slug='notes/old' AND t.slug='people/zhang'"))[0]?.n);
  expect(await countLinks()).toBe(0);
  const { readMentionCoverage } = await import('../src/core/mentions/coverage.ts');
  expect((await readMentionCoverage(engine, ['default'])).state).toBe('pending');
  expect((await runMentionPass(engine, { sourceId: 'default' })).state).not.toBe('failed');
  expect(await countLinks()).toBe(1);
  expect((await readMentionCoverage(engine, ['default'])).state).toBe('complete');
  expect(calls).toBe(0);
}, 90_000);

test('旧快速维护断点保留实体识别记录，继续时只执行新的维护范围', async () => {
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '已有人员。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('notes/resume', { type: 'note', title: '恢复资料', compiled_truth: '张三参与工作。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  const phase = (name: string, status: string, details: Record<string, unknown> = {}) => ({ phase: name, status, summary: name, duration_ms: 1, details });
  const capture = phase('capture_entities', 'warn', { pages_remaining: 8 });
  const oldPhases = [phase('sync', 'skipped'), phase('extract', 'ok'), capture, phase('embed', 'warn', { remainingChunks: 50 })];
  const checkpoint = { phases: { default: oldPhases }, reports: { default: { status: 'partial', phases: oldPhases } } } as any;
  const task = await runtime.submitDream({ preset: 'quick', sourceId: 'default', checkpoint });
  const done = await finished(task.id, 90_000);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect((done.result as any).phases.map((item: any) => item.phase)).not.toContain('capture_entities');
  expect((done.result as any).phases.map((item: any) => item.phase)).not.toContain('embed');
  const [job] = await engine.executeRaw<{ retired: any }>("SELECT data->'task'->'input'->'checkpoint'->'retiredCapture'->'default' AS retired FROM minion_jobs WHERE id=$1", [Number(task.id.slice(5))]);
  expect(job.retired.phases[0].details.pages_remaining).toBe(8);
  expect(job.retired.phases.find((item: any) => item.phase === 'embed').details.remainingChunks).toBe(50);
  expect(job.retired.report.phases.some((item: any) => item.phase === 'capture_entities')).toBe(true);
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
}, 180_000);

test('关闭自动提及匹配时快速维护遵循现有设置', async () => {
  await engine.setConfig('mentions.auto_link', 'false');
  try {
    await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '张三在星河公司任职。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.putPage('companies/example', { type: 'company', title: '星河公司', compiled_truth: '已有公司。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const report = await runQuickMaintenance(engine, { brainDir: null, sourceId: 'default' });
    expect(report.status).not.toBe('failed');
    const links = await engine.executeRaw("SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id WHERE f.source_id='default' AND l.link_source='mentions'");
    expect(links).toHaveLength(0);
    expect(calls).toBe(0);
    expect(embeddingCalls).toBe(0);
  } finally {
    await engine.setConfig('mentions.auto_link', 'true');
  }
}, 90_000);

test('快速维护尊重现有排除项目类型的设置', async () => {
  await engine.setConfig('mentions.entity_types', '-project');
  try {
    await engine.putPage('projects/water', { type: 'project', title: '智慧水务项目', compiled_truth: '已有项目。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.putPage('notes/project', { type: 'note', title: '项目资料', compiled_truth: '智慧水务项目已经开始。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    const report = await runQuickMaintenance(engine, { brainDir: null, sourceId: 'default' });
    expect(report.status).not.toBe('failed');
    const links = await engine.executeRaw("SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug='notes/project' AND t.slug='projects/water'");
    expect(links).toHaveLength(0);
    expect(calls).toBe(0);
  } finally {
    await engine.executeRaw("DELETE FROM config WHERE key='mentions.entity_types'");
  }
}, 90_000);

test('后台任务单资料八轮耗尽仍处理后续资料，原任务继续只重试失败资料',async()=>{
  const directory=join(root,'turn-limit-source');mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[directory]);
  for(const slug of ['a-bad','z-good']){
    const page={slug,type:'note',compiled_truth:`${slug} 是独立原文，必须保存已有成果和失败断点。`,frontmatter:{}};
    await engine.putPage(slug,{...page,title:slug,timeline:''},{sourceId:'default'});
    await requestImportedEntityCapture(engine,'default',page);
  }
  incompleteSlug='a-bad';await engine.setConfig('dream.entity_capture.cost_cap_cny','unlimited');
  const quick=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs:['a-bad','z-good']}),done=await finished(quick.id,90000);
  expect(calls).toBe(9);
  const capture=(done.result as {phases:Array<{phase:string;details:Record<string,any>}>}).phases.find(phase=>phase.phase==='capture_entities');
  expect(capture?.details).toMatchObject({pages_processed:1,pages_failed:1,pages_remaining:1,stop_reason:'document_turns',budget_stop:null});
  const success=await engine.executeRaw("SELECT id FROM minion_jobs WHERE result->>'ingest_verified'='true' AND data->'ingest_context'->>'slug'='z-good'");
  expect(success).toHaveLength(1);
  incompleteSlug='';expect((await runtime.retry(quick.id))?.id).toBe(quick.id);
  const resumed=await finished(quick.id,90000);expect(resumed.status,JSON.stringify(resumed.result)).toBe('completed');expect(calls).toBe(10);
  expect((await engine.getPage('a-bad'))?.compiled_truth).toContain('独立原文');
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE result->>'ingest_verified'='true' AND data->'ingest_context'->>'slug'='z-good'")).toHaveLength(1);
},180000);

test('显式实体摄入保留费用上限，继续原任务不重复已完成资料',async()=>{
  const path=configPath(),originalConfig=readFileSync(path,'utf8'),config=JSON.parse(originalConfig);
  config.desktop.model_services=[{id:'fixture',provider:'custom-openai',name:'隔离远程',baseUrl:'https://fixture.invalid/v1',apiKey:'isolated-only',enabled:true,models:[{id:'isolated-capture',name:'isolated-capture',kind:'chat',group:'fixture',capabilities:[],inputPriceCny:10,outputPriceCny:10}]}];
  writeFileSync(path,JSON.stringify(config));
  try{
  for(const slug of ['first','second'])await engine.putPage(slug,{title:slug,type:'note',compiled_truth:`${slug} 是费用测试原文。`,timeline:'',frontmatter:{}},{sourceId:'default'});
  usageInput=60000;
  await engine.setConfig('dream.entity_capture.cost_cap_cny','0.5');
  const task=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs:['first','second']});
  await finished(task.id);expect(calls).toBe(1);
  await runtime.retry(task.id);await finished(task.id);expect(calls).toBe(1);
  await engine.setConfig('dream.entity_capture.cost_cap_cny','2');
  await runtime.retry(task.id);expect((await finished(task.id)).status).toBe('completed');expect(calls).toBe(2);
  expect((await engine.getPage('first'))?.compiled_truth).toContain('费用测试原文');
  expect((await engine.getPage('second'))?.compiled_truth).toContain('费用测试原文');
  }finally{writeFileSync(path,originalConfig);}
},90000);

test('显式实体任务停止并重启后仍能原任务继续，不派生自动整理',async()=>{
  await engine.setConfig('dream.entity_capture.enabled','false');
  const repo=join(root,'stopped');mkdirSync(repo);
  for(let i=0;i<3;i++)writeFileSync(join(repo,`stop-${i}.md`),`# 停止资料${i}\n\n这些原文在停止及继续后都应完整保留。`);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[repo]);
  expect((await finished((await runtime.submitDream({preset:'quick',sourceId:'default'})).id)).status).toBe('completed');
  hold=true;
  const quick=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs:['stop-0','stop-1','stop-2']});
  await until(async()=>calls>0);
  await runtime.cancel(quick.id);release();await runtime.close();
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE private_queue_owner_job_id=$1 AND status IN ('waiting','active','delayed')", [Number(quick.id.slice(5))])).toHaveLength(0);
  runtime=new ProductTaskRuntime(engine);await runtime.start();await Bun.sleep(250);
  expect((await runtime.listRuns()).filter(run=>run.kind==='dream_capture_entities'&&run.trigger==='scheduled')).toHaveLength(0);
  const resumed=await runtime.retry(quick.id);expect(resumed?.id).toBe(quick.id);
  expect((await finished(quick.id)).status).toBe('completed');
  for(let i=0;i<3;i++)expect((await engine.getPage(`stop-${i}`,{sourceId:'default'}))?.compiled_truth).toContain('完整保留');
},90_000);

test('旧版显式排队兼容函数保留Source归属且不抢占同步父任务', async () => {
  await runtime.close();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','另一个源')");
  await engine.setConfig('dream.entity_capture.pending.default', JSON.stringify({ nonce: 'one', incremental:true, slugs: ['notes/one'] }));
  await engine.setConfig('dream.entity_capture.pending.other', JSON.stringify({ nonce: 'two', incremental:true, slugs: ['notes/two'] }));
  const queue = new MinionQueue(engine);
  const parent = await queue.add('pmbrain-product-task', { kind: 'dream_quick', task: { type: 'dream', input: { preset: 'quick', sourceId: 'default' } } }, { queue: PRODUCT_TASK_QUEUE });
  await engine.executeRaw("UPDATE minion_jobs SET status='waiting-children' WHERE id=$1", [parent.id]);
  await requestImportedEntityCapture(engine,'default',{slug:'notes/three',type:'note',compiled_truth:'等待文件同步完成的完整原文资料。',frontmatter:{}});
  expect(JSON.parse((await engine.getConfig('dream.entity_capture.pending.default'))!).ownerJobId).toBe(parent.id);
  const submitted = await enqueueImportedEntityCapture(engine, async () => true);
  expect(submitted).toHaveLength(1);
  const job = await queue.getJob(submitted[0]!);
  expect((job?.data.task as { input: { sourceId: string } }).input.sourceId).toBe('other');
  expect(await engine.getConfig('dream.entity_capture.pending.default')).not.toBeNull();
  expect(await engine.getConfig('dream.entity_capture.pending.other')).toBeNull();
  for (const status of ['paused','cancelled']) {
    await engine.executeRaw('UPDATE minion_jobs SET status=$2 WHERE id=$1',[parent.id,status]);
    expect(await enqueueImportedEntityCapture(engine,async()=>true)).toEqual([]);
    expect(await engine.getConfig('dream.entity_capture.pending.default')).not.toBeNull();
  }
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1",[parent.id]);
  const resumed = await enqueueImportedEntityCapture(engine,async()=>true);
  expect(resumed).toHaveLength(1);
  expect(((await queue.getJob(resumed[0]))?.data.task as {input:{sourceId:string}}).input.sourceId).toBe('default');
  expect(await engine.getConfig('dream.entity_capture.pending.default')).toBeNull();
});

test('快速维护跳过备份目录且不调用模型',async()=>{
  const repo=join(root,'duplicate-backups');mkdirSync(join(repo,'backups'),{recursive:true});mkdirSync(join(repo,'备份'),{recursive:true});
  const body='---\ntitle: 重复资料\ntype: note\n---\n这是一份用于核对备份重复识别的工作资料。';
  writeFileSync(join(repo,'original.md'),body);
  writeFileSync(join(repo,'backups','copy.md'),body);
  writeFileSync(join(repo,'备份','new.md'),body+'这份备份增加了新的工作内容。');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[repo]);
  const run=await runtime.submitDream({preset:'quick',sourceId:'default'});
  const done=await finished(run.id,180000);
  expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(0);
  const jobs=await engine.executeRaw<{quick:string}>("SELECT data->'ingest_context'->>'quickEntitiesOnly' quick FROM minion_jobs WHERE data ? 'ingest_context'");
  expect(jobs).toHaveLength(0);
  expect(await engine.getPage('original',{sourceId:'default'})).not.toBeNull();
  expect(await engine.getPage('backups/copy',{sourceId:'default'})).toBeNull();
  expect(await engine.getPage('备份/new',{sourceId:'default'})).toBeNull();
  const repeat=await runtime.submitDream({preset:'quick',sourceId:'default'});
  expect((await finished(repeat.id,180000)).status).toBe('completed');expect(calls).toBe(0);
},360000);

test('历史跳过记录读成未执行失败，不能绿色完成，也不改写历史记录', async () => {
  await runtime.close();
  const queue = new MinionQueue(engine);
  const job = await queue.add('pmbrain-product-task', { kind: 'dream_full', task: { type: 'dream', input: { preset: 'full' } } }, { queue: 'held-history' });
  const result = { status: 'skipped', reason: 'cycle_already_running', phases: [], totals: {} };
  await engine.executeRaw("UPDATE minion_jobs SET queue=$2,status='completed',result=$3::jsonb,finished_at=now() WHERE id=$1", [job.id, PRODUCT_TASK_QUEUE, result]);
  const run = (await runtime.getRun(`task-${job.id}`))!;
  expect(run.status).toBe('failed'); expect(run.product?.errorReason).toContain('未执行');
  expect(taskRoundCompleted(run as ConsoleRun)).toBe(false); expect(taskStatus(run as ConsoleRun)).toBe('未执行');
  expect((await queue.getJob(job.id))?.status).toBe('completed');
  expect((await queue.getJob(job.id))?.result).toEqual(result);
});

test('外部周期锁占用时保留同一排队任务，释放后真正执行，排队时可以停止', async () => {
  const lock = (await tryAcquireDbLock(engine, 'gbrain-cycle:default'))!;
  expect(lock).not.toBeNull();
  try {
    const deep = await runtime.submitDream({ phase: 'backlinks', sourceId: 'default' });
    let waiting: ConsoleRun | undefined;
    await until(async () => { const run = await runtime.getRun(deep.id); if (run?.status === 'queued' && run.product?.stage === '等待前面的整理任务完成') waiting = run as ConsoleRun; return !!waiting; });
    expect(waiting?.status).toBe('queued');
    expect(taskRoundCompleted(waiting!)).toBe(false);
    await lock.release();
    const done = await finished(deep.id);
    expect(done.status).toBe('completed');
    expect((done.result as { phases: unknown[] }).phases).not.toHaveLength(0);
    const nextLock = (await tryAcquireDbLock(engine, 'gbrain-cycle:default'))!;
    try {
      const quick = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
      await until(async () => { const run = await runtime.getRun(quick.id); return run?.status === 'queued' && run.product?.stage === '等待前面的整理任务完成'; });
      expect((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id).toBe(quick.id);
      expect((await runtime.cancel(quick.id))?.status).toBe('cancelled');
      expect((await runtime.listRuns()).map(run => run.id).sort()).toEqual([deep.id, quick.id].sort());
    } finally { await nextLock.release(); }
  } finally { await lock.release(); }
}, 60_000);

test('深度整理接收导入实体请求时归属原主任务，不再额外排队一轮整理', async () => {
  const queue = new MinionQueue(engine);
  const parent = await queue.add('pmbrain-product-task', { kind: 'dream_full', fileSession: true, task: { type: 'dream', input: { preset: 'full', sourceId: 'default' } } }, { queue: PRODUCT_TASK_QUEUE, delay: 86400000 });
  await engine.executeRaw("UPDATE minion_jobs SET status='active',lock_token='deep-owner' WHERE id=$1", [parent.id]);
  await requestImportedEntityCapture(engine, 'default', { slug: 'deep-input', type: 'source', compiled_truth: '这是一份需要整理实体的资料。', frontmatter: {} });
  expect(await enqueueImportedEntityCapture(engine, async () => true)).toEqual([]);
  const pending = JSON.parse((await engine.getConfig('dream.entity_capture.pending.default'))!);
  expect(pending.ownerJobId).toBe(parent.id);
});

test('显式实体摄入校验失败保留原任务继续，不自动开启另一轮', async () => {
  await engine.setConfig('dream.entity_capture.enabled','false');
  const repo = join(root, 'invalid'); mkdirSync(repo);
  writeFileSync(join(repo, 'input.md'), '# 校验资料\n\n这份资料用于确认无效回执不会被假装成功。');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  expect((await finished((await runtime.submitDream({preset:'quick',sourceId:'default'})).id)).status).toBe('completed');
  invalid = true;
  const quick = await runtime.submitDream({ phase: 'capture_entities', sourceId: 'default',slugs:['input'] });
  const done = await finished(quick.id);
  expect(done.status).toBe('failed'); expect(done.product?.errorReason).toContain('ingest');
  expect((await runtime.listRuns()).filter(run => run.kind === 'dream_capture_entities' && run.trigger==='scheduled')).toHaveLength(0);
  const count = calls; await Bun.sleep(350); expect(calls).toBe(count);
  invalid = false;
  const resumed = await runtime.retry(quick.id);
  expect(resumed?.id).toBe(quick.id);
  expect((await finished(quick.id)).status).toBe('completed');
  expect(await engine.getPage('input', { sourceId: 'default' })).not.toBeNull();
}, 90_000);
