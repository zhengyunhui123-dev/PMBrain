import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
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
import { idleBackground } from './helpers/background-resources.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { taskRoundCompleted, taskStatus } from '../admin/src/product/task-presentation.ts';
import type { ConsoleRun } from '../shared/contracts/common.ts';

let engine: BrainEngine, runtime: ProductTaskRuntime, root: string, server: ReturnType<typeof Bun.serve>;
let calls = 0, embeddingCalls = 0, hold = false, holdEmbedding = false, invalid = false, usageInput = 20, incompleteSlug = '';
let embeddingInputs: string[] = [];
const releases = new Set<() => void>();
const embeddingReleases = new Set<() => void>();
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

function release() { hold = false; holdEmbedding = false; for (const finish of releases) finish(); releases.clear(); for (const finish of embeddingReleases) finish(); embeddingReleases.clear(); }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-orchestration-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root; process.env.GBRAIN_HOME = root; mkdirSync(join(root, '.pmbrain'));
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { input?: string | string[]; messages?: unknown[] };
    if (new URL(req.url).pathname.endsWith('/embeddings')) { embeddingCalls++; embeddingInputs.push(...(Array.isArray(body.input) ? body.input : [body.input]).filter((value): value is string => typeof value === 'string')); if (holdEmbedding) await new Promise<void>(finish => embeddingReleases.add(finish)); return Response.json({ object: 'list', data: (Array.isArray(body.input) ? body.input : [body.input]).map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })), model: 'isolated-embedding', usage: { prompt_tokens: 2, total_tokens: 2 } }); }
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
  calls = 0; embeddingCalls = 0; embeddingInputs = []; invalid = false; usageInput = 20; incompleteSlug = ''; release();
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'pmbrain.search_optimize%'");
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
  runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
}, 30_000);

afterEach(async () => { release(); await runtime?.close(); }, 30_000);
afterAll(async () => {
  release(); await runtime?.close(); await engine?.disconnect(); server?.stop(true);
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('pmbrain-orchestration-')) rmSync(root, { recursive: true, force: true });
}, 60_000);

test('快速维护按本地路径同步无提交仓库、未提交及 Git 忽略的文件并切块', async () => {
  const directory = join(root, 'quick-no-commit');
  mkdirSync(directory);
  execFileSync('git', ['init', '-q', directory]);
  writeFileSync(join(directory, '.gitignore'), 'ignored.md\n');
  writeFileSync(join(directory, 'pending.md'), '# 待同步资料\n\n未提交但可读取的正文。');
  writeFileSync(join(directory, 'ignored.md'), '# 忽略资料\n\nGit 忽略但路径中可读取的正文。');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.setConfig('sync.include_working_tree', 'false');
  await engine.setConfig('sync.auto_git_commit', 'false');
  const done = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect((done.result as { status?: string }).status).not.toBe('partial');
  expect((await engine.getPage('pending', { sourceId: 'default' }))?.compiled_truth).toContain('未提交但可读取');
  expect((await engine.getPage('ignored', { sourceId: 'default' }))?.compiled_truth).toContain('Git 忽略');
  const chunks = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.slug IN ('pending','ignored')");
  expect(Number(chunks[0]?.n)).toBeGreaterThanOrEqual(2);
  expect(calls).toBe(0);
}, 180_000);

test('本轮资料已处理后，历史关联和旧识图不算快速维护未完成', async () => {
  const directory = join(root, 'quick-current-scope');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '已有人员。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('notes/old', { type: 'note', title: '历史资料', compiled_truth: '历史资料提及张三。', timeline: '', frontmatter: { document_ocr_deferred: 'true', document_ocr_task_id: '999999', document_ocr_failed: 1 } }, { sourceId: 'default' });
  writeFileSync(join(directory, 'current.md'), '# 本轮资料\n\n张三参与了本轮工作。');
  const done = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect((done.result as { status?: string }).status).not.toBe('partial');
  expect((done.result as { ocrPending?: number }).ocrPending ?? 0).toBe(0);
  const old = await engine.executeRaw<{ links_extracted_at: Date | null }>("SELECT links_extracted_at FROM pages WHERE source_id='default' AND slug='notes/old'");
  expect(old[0]?.links_extracted_at).toBeNull();
  const linked = await engine.executeRaw("SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug='current' AND t.slug='people/zhang'");
  expect(linked.length).toBeGreaterThan(0);
  expect(calls).toBe(0);
}, 180_000);

test('快速维护遇到失联路径不显示完成，也不删除已有页面', async () => {
  const directory = join(root, 'quick-missing-root');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.putPage('notes/keep', { type: 'note', title: '保留资料', compiled_truth: '路径失联时保留的正文。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.executeRaw("UPDATE pages SET source_path='notes/keep.md' WHERE source_id='default' AND slug='notes/keep'");
  const done = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(done.status === 'failed' || (done.result as { status?: string })?.status === 'partial').toBe(true);
  expect((await engine.getPage('notes/keep', { sourceId: 'default' }))?.compiled_truth).toBe('路径失联时保留的正文。');
  expect(calls).toBe(0);
}, 180_000);

test('无 Git 目录中文件改名后仍保留原页面和既有关联', async () => {
  const directory = join(root, 'quick-path-rename');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  writeFileSync(join(directory, 'old.md'), '---\ntitle: 移动资料\ntype: note\n---\n文件移动前后的正文不变。');
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  const original = await engine.getPage('old', { sourceId: 'default' });
  expect(original).not.toBeNull();
  await engine.putPage('reference', { type: 'note', title: '已有引用', compiled_truth: '引用移动资料。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.addLink('reference', 'old', '已有引用', 'mentions', 'manual');
  renameSync(join(directory, 'old.md'), join(directory, 'new.md'));
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  const moved = await engine.getPage('new', { sourceId: 'default' });
  expect(moved?.id).toBe(original?.id);
  expect(moved?.compiled_truth).toContain('文件移动前后的正文不变');
  const links = await engine.executeRaw("SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug='reference' AND t.slug='new' AND f.source_id='default' AND t.source_id='default'");
  expect(links.length).toBeGreaterThan(0);
  renameSync(join(directory, 'new.md'), join(directory, 'NEW.md'));
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  expect((await engine.getPage('new', { sourceId: 'default' }))?.id).toBe(original?.id);
  const [renamed] = await engine.executeRaw<{ source_path: string }>("SELECT source_path FROM pages WHERE slug='new' AND source_id='default' AND deleted_at IS NULL");
  expect(renamed?.source_path).toBe('NEW.md');
}, 180_000);

test('旧版没有文件指纹的 Markdown 改名后仍保留页面身份', async () => {
  const directory = join(root, 'quick-legacy-rename');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  writeFileSync(join(directory, 'old.md'), '---\ntitle: 旧版资料\ntype: note\n---\n旧版保存的资料正文。');
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  const original = await engine.getPage('old', { sourceId: 'default' });
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'sync.file.sha256:%'");
  renameSync(join(directory, 'old.md'), join(directory, 'new.md'));
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  expect((await engine.getPage('new', { sourceId: 'default' }))?.id).toBe(original?.id);
}, 180_000);

test('旧版没有文件回执的 Word 改名后仍保留页面身份', async () => {
  const directory = join(root, 'quick-legacy-word-rename');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  const document = new JSZip();
  document.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>旧版文档中的正文内容。</w:t></w:r></w:p></w:body></w:document>');
  writeFileSync(join(directory, 'old.docx'), await document.generateAsync({ type: 'uint8array' }));
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  const original = await engine.getPage('old.docx', { sourceId: 'default' });
  expect(original).not.toBeNull();
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'sync.file.sha256:%'");
  renameSync(join(directory, 'old.docx'), join(directory, 'new.docx'));
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  expect((await engine.getPage('new.docx', { sourceId: 'default' }))?.id).toBe(original?.id);
}, 180_000);

test('本轮变化页后台向量化不等待维护，也不领取旧识图队列', async () => {
  const directory = join(root, 'quick-vectors');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.putPage('notes/old', { type: 'note', title: '历史资料', compiled_truth: '历史向量内容不属于本轮。', timeline: '', frontmatter: { document_ocr_deferred: 'true' } }, { sourceId: 'default' });
  await engine.upsertChunks('notes/old', [{ chunk_index: 0, chunk_text: '历史向量内容不属于本轮。', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
  const { enqueueSearchOptimize } = await import('../src/product/tasks/search-optimize-store.ts');
  await enqueueSearchOptimize(engine, 'default', ['notes/old']);
  holdEmbedding = true;
  writeFileSync(join(directory, 'fresh.md'), '# 本轮向量资料\n\n本轮向量的独立正文。');
  const done = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  expect((done.result as { status?: string }).status).not.toBe('partial');
  await until(async () => embeddingCalls > 0, 30_000);
  expect(embeddingInputs.join('\n')).toContain('本轮向量的独立正文');
  expect(embeddingInputs.join('\n')).not.toContain('历史向量内容');
  const vectorJobs = await engine.executeRaw<{ window_ms: string }>("SELECT data->'task'->'input'->>'windowMs' AS window_ms FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true'");
  expect(vectorJobs).toHaveLength(1);
  expect(Number(vectorJobs[0]?.window_ms)).toBe(1_800_000);
  expect(calls).toBe(0);
  release();
  await until(async () => Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.slug='fresh' AND c.embedding IS NOT NULL"))[0]?.n) > 0, 30_000);
  const old = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.slug='notes/old' AND c.embedding IS NOT NULL");
  expect(Number(old[0]?.n)).toBe(0);
}, 180_000);

test('未启用向量模型时资料维护仍完成，后台任务保留原始错误', async () => {
  const directory = join(root, 'quick-vector-disabled');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  const originalConfig = readFileSync(configPath(), 'utf8');
  const changedConfig = JSON.parse(originalConfig);
  changedConfig.embedding_disabled = true;
  writeFileSync(configPath(), JSON.stringify(changedConfig));
  try {
    writeFileSync(join(directory, 'no-model.md'), '# 未配置向量\n\n这份正文仍应正常保存。');
    const done = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
    expect(done.status).toBe('completed');
    expect((done.result as { status?: string }).status).not.toBe('partial');
    expect((await engine.getPage('no-model', { sourceId: 'default' }))?.compiled_truth).toContain('正文仍应正常保存');
    await until(async () => (await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true' AND status IN ('failed','dead')")).length > 0, 30_000);
    expect(embeddingCalls).toBe(0);
    expect(calls).toBe(0);
  } finally {
    writeFileSync(configPath(), originalConfig);
  }
}, 180_000);

test('后台向量任务在服务重启后继续处理本轮页面', async () => {
  const directory = join(root, 'quick-vector-restart');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  holdEmbedding = true;
  writeFileSync(join(directory, 'restart.md'), '# 重启资料\n\n后台向量任务重启后继续。');
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  await until(async () => embeddingCalls > 0, 30_000);
  const [job] = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true'");
  expect(job).toBeDefined();
  await runtime.close();
  release();
  runtime = new ProductTaskRuntime(engine, { background: idleBackground }); await runtime.start();
  await until(async () => (await runtime.getRun(`task-${job!.id}`))?.status === 'completed', 40_000);
  expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug='restart' AND p.source_id='default' AND c.embedding IS NOT NULL"))[0]?.n)).toBeGreaterThan(0);
  expect(calls).toBe(0);
}, 180_000);

test('本轮向量窗口到期后自动续跑同一任务并复用已保存分块', async () => {
  const directory = join(root, 'quick-vector-window');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  holdEmbedding = true;
  writeFileSync(join(directory, 'window.md'), '# 窗口资料\n\n向量窗口结束后继续处理。');
  const done = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default', windowSeconds: 1.5 })).id, 90_000);
  expect(done.status).toBe('completed');
  await until(async () => embeddingCalls >= 2, 30_000);
  const jobs = await engine.executeRaw<{ id: number; window_ms: string }>("SELECT id,data->'task'->'input'->>'windowMs' AS window_ms FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true'");
  expect(jobs).toHaveLength(1);
  expect(Number(jobs[0]?.window_ms)).toBe(1500);
  release();
  await until(async () => (await runtime.getRun(`task-${jobs[0]!.id}`))?.status === 'completed', 30_000);
  const saved = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug='window' AND p.source_id='default' AND c.embedding IS NOT NULL");
  expect(Number(saved[0]?.n)).toBeGreaterThan(0);
  expect(calls).toBe(0);
}, 180_000);

test('恢复后台向量化时，同一暂停期间排队的各轮资料都会继续', async () => {
  const directory = join(root, 'quick-vector-global-pause');
  mkdirSync(directory);
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  const { pauseSearchOptimize } = await import('../src/product/tasks/search-optimize-store.ts');
  await pauseSearchOptimize(engine, true);
  await engine.putPage('history', { type: 'note', title: '旧资料', compiled_truth: '不属于本轮的历史向量。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.upsertChunks('history', [{ chunk_index: 0, chunk_text: '不属于本轮的历史向量。', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
  const historical = await runtime.acceptSearchOptimize('default', ['history']);
  expect(historical.jobId).not.toBeNull();
  writeFileSync(join(directory, 'first.md'), '# 第一轮\n\n需要恢复的第一份资料。');
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  writeFileSync(join(directory, 'second.md'), '# 第二轮\n\n需要恢复的第二份资料。');
  expect((await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000)).status).toBe('completed');
  const jobs = await engine.executeRaw<{ id: number; status: string }>("SELECT id,status FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true' ORDER BY id");
  expect(jobs).toHaveLength(2);
  expect(jobs.every(job => job.status === 'paused')).toBe(true);
  await runtime.continueSearchOptimize(`task-${jobs[0]!.id}`);
  await until(async () => (await Promise.all(jobs.map(job => runtime.getRun(`task-${job.id}`)))).every(run => run?.status === 'completed'), 30_000);
  expect((await runtime.getRun(`task-${historical.jobId}`))?.status).toBe('paused');
  expect(embeddingInputs.join('\n')).not.toContain('不属于本轮的历史向量');
  expect(calls).toBe(0);
}, 180_000);

test('维护断点重试时复用本轮向量任务，即使待处理分块已经变化', async () => {
  const { pauseSearchOptimize } = await import('../src/product/tasks/search-optimize-store.ts');
  await pauseSearchOptimize(engine, true);
  for (const slug of ['retry-one', 'retry-two']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter: {} }, { sourceId: 'default' });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: slug, chunk_source: 'compiled_truth' }], { sourceId: 'default' });
  }
  const submit = (slugs: string[]) => (runtime as any).submitQuickVectors(12345, 'default', slugs, 1_800_000) as Promise<{ taskId?: string; pages: number }>;
  const first = await submit(['retry-one', 'retry-two']);
  expect(first.taskId).toBeDefined();
  await engine.executeRaw("DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE slug='retry-two' AND source_id='default')");
  expect((await submit(['retry-two', 'retry-one'])).taskId).toBe(first.taskId);
  await engine.executeRaw("DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE slug='retry-one' AND source_id='default')");
  expect((await submit(['retry-one', 'retry-two'])).taskId).toBe(first.taskId);
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true'")).toHaveLength(1);
}, 180_000);

test('同步多份资料只有一个维护主任务，向量化独立完成且无变化时不重复调用', async () => {
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
  expect(done.status, JSON.stringify(done.result)).toBe('completed');
  const phases = (done.result as { phases: Array<{ phase: string; status: string; details: Record<string, any> }> }).phases;
  expect(phases.some(phase => phase.phase === 'capture_entities' || phase.phase === 'embed')).toBe(false);
  const deepDone = await finished(deep.id);
  expect(deepDone.status).toBe('completed');
  expect((deepDone.result as { phases: Array<{ phase: string }> }).phases.some(phase => phase.phase === 'backlinks')).toBe(true);
  expect((deepDone.result as { reason?: string }).reason).not.toBe('cycle_already_running');
  await until(async () => (await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true' AND status<>'completed'")).length === 0, 30_000);
  expect(embeddingCalls).toBeGreaterThan(0);
  const embeddingsAfterFirst = embeddingCalls;
  const count = calls;
  const next = await runtime.submitDream({ preset: 'quick', sourceId: 'default' });
  expect((await finished(next.id)).status).toBe('completed');
  expect(calls).toBe(count);
  expect(embeddingCalls).toBe(embeddingsAfterFirst);
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
  mkdirSync(join(directory, 'people'));
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '张三在星河公司任职。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('companies/example', { type: 'company', title: '星河公司', compiled_truth: '已有公司。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('projects/water', { type: 'project', title: '智慧水务项目', compiled_truth: '已有项目。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.setPageAliases('projects/water', 'default', ['蓝水工程']);
  await engine.putPage('organizations/team', { type: 'organization', title: '星河团队', compiled_truth: '已有组织。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('backups/keep', { type: 'note', title: '旧备份', compiled_truth: '旧备份需要保留。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  writeFileSync(join(directory, 'people', 'zhang.md'), '---\ntitle: 张三\ntype: person\n---\n张三在星河公司任职。');
  writeFileSync(join(directory, 'material.md'), '---\ntitle: 新资料\ntype: note\n---\n张三和星河团队参与星河公司的蓝水工程。新名字李四仅出现在原文中。');
  writeFileSync(join(directory, 'backups', 'keep.md'), '---\ntitle: 修改过的备份\ntype: note\n---\n张三不应从备份建立关系。');
  writeFileSync(join(directory, 'notes.bak.md'), '---\ntitle: 备份文件\ntype: note\n---\n星河公司不应从备份建立关系。');
  const first = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  expect(first.status, JSON.stringify(first.result)).toBe('completed');
  expect(calls).toBe(0);
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
  await until(async () => (await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'quickVector'='true' AND status<>'completed'")).length === 0, 30_000);
  const embeddingsAfterFirst = embeddingCalls;
  const repeatStarted = performance.now();
  const next = await finished((await runtime.submitDream({ preset: 'quick', sourceId: 'default' })).id, 90_000);
  console.log(`[quick-unchanged] ${Math.round(performance.now()-repeatStarted)} ms`);
  expect(next.status, JSON.stringify(next.result)).toBe('completed');
  expect(calls).toBe(0);
  expect(embeddingCalls).toBe(embeddingsAfterFirst);
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
}, 180_000);

test('待补关联按批次保存并可继续，未完成时不显示全部完成', async () => {
  const directory = join(root, 'quick-relation-resume');
  mkdirSync(join(directory, 'notes'), { recursive: true });
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [directory]);
  await engine.putPage('people/zhang', { type: 'person', title: '张三', compiled_truth: '已有人员。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('notes/history', { type: 'note', title: '历史资料', compiled_truth: '张三参与旧工作。', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  for (let i = 0; i < 7; i++) {
    writeFileSync(join(directory, 'notes', `batch-${i}.md`), `---\ntitle: 资料${i}\ntype: note\n---\n张三参与第${i}项工作。`);
  }
  const { resumeMaintenanceCheckpoint } = await import('../src/product/tasks/checkpoint.ts');
  let checkpoint: any = { phases: {}, reports: {} };
  let complete = false;
  for (let round = 0; round < 12; round++) {
    const report = await runQuickMaintenance(engine, { brainDir: directory, sourceId: 'default', markdownCatchUpMaxHistorical: 2, byMentionMaxHistorical: 2, byMentionTimeBudgetMs: 30_000, completedPhases: checkpoint.phases.default, phaseCheckpoint: async phases => { checkpoint = { phases: { default: structuredClone(phases) }, reports: {} }; } });
    const extract = report.phases.find(phase => phase.phase === 'extract')!;
    expect(Number(extract.details.relationPagesProcessed ?? 0)).toBeLessThanOrEqual(2);
    expect(Number(extract.details.mentionPagesProcessed ?? 0)).toBeLessThanOrEqual(2);
    if (round === 0) {
      expect(report.status).toBe('partial');
      expect(Number(extract.details.remaining)).toBeGreaterThan(0);
    }
    if (report.status === 'ok' || report.status === 'clean') { complete = true; break; }
    resumeMaintenanceCheckpoint(checkpoint, true, true);
  }
  expect(complete).toBe(true);
  const links = await engine.executeRaw<{ n: number }>("SELECT count(*)::int n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug LIKE 'notes/batch-%' AND t.slug='people/zhang'");
  expect(Number(links[0]?.n)).toBe(7);
  expect((await engine.executeRaw<{ links_extracted_at: Date | null }>("SELECT links_extracted_at FROM pages WHERE source_id='default' AND slug='notes/history'"))[0]?.links_extracted_at).toBeNull();
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
  expect((await runMentionPass(engine, { sourceId: 'default' })).state).not.toBe('failed');
  expect(await countLinks()).toBe(1);
  const { readMentionCoverage } = await import('../src/core/mentions/coverage.ts');
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
  runtime=new ProductTaskRuntime(engine,{background:idleBackground});await runtime.start();await Bun.sleep(250);
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
