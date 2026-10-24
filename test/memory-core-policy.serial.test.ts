import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { BrainEngine } from '../src/core/engine';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import { loadCoreBlock, sessionMemoryPreface } from '../src/core/core-memory';
import { operationsByName, type OperationContext } from '../src/core/operations';
import { dispatchToolCall } from '../src/mcp/dispatch';
import { nativeMemoryHandlers, workbenchMemoryTools } from '../src/product/workbench/memory-tools';
import { WorkbenchStore } from '../src/product/workbench/store';

const url = process.env.PMBRAIN_MEMORY_TEST_DATABASE_URL;
if (url) assertSafeE2eDatabaseUrl(url);
const engine: BrainEngine = url ? new PostgresEngine() : new PGLiteEngine();
const root = mkdtempSync(join(tmpdir(), 'pmbrain-core-policy-'));
const previousHome = process.env.PMBRAIN_HOME;
const store = new WorkbenchStore(join(root, 'sessions'));
const sourceId = 'core-policy-test';
const otherSource = 'core-policy-other-test';
const ctx = (source = sourceId): OperationContext => ({ engine, sourceId: source, remote: false, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const remember = (fact: string, extra: Record<string, unknown> = {}, source = sourceId) => operationsByName.remember.handler(ctx(source), { fact, provenance: '隔离记忆验收', visibility: 'world', ...extra }) as Promise<{ id: string; status: string }>;
const forget = (id: string, source = sourceId) => operationsByName.forget.handler(ctx(source), { id });
const page = (slug: string, body: string, source = sourceId, frontmatter: Record<string, unknown> = {}) => engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, timeline: '', frontmatter: { always_load: true, ...frontmatter } }, { sourceId: source });
const core = () => loadCoreBlock(engine, { sessionSourceId: sourceId, excludePrivate: false });
async function rejection(action: Promise<unknown>): Promise<string> {
  try { await action; }
  catch (error) { return String(error); }
  throw new Error('Expected the operation to reject');
}

beforeAll(async () => {
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: engine.kind, memory: { auto_writeback: 'all' } }));
  resetGateway();
  configureGateway({ env: {} });
  await engine.connect(url ? { database_url: url } : {});
  await engine.initSchema();
  await engine.executeRaw('DROP TRIGGER IF EXISTS test_reject_withdrawal ON fact_withdrawals');
  await engine.executeRaw('DROP FUNCTION IF EXISTS test_reject_withdrawal()');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1),($2,$2) ON CONFLICT DO NOTHING', [sourceId, otherSource]);
  await engine.setConfig('facts.default_visibility', 'world');
}, 120_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts WHERE source_id=ANY($1::text[])', [ [sourceId, otherSource] ]);
  await engine.executeRaw('DELETE FROM fact_withdrawals WHERE source_id=ANY($1::text[])', [ [sourceId, otherSource] ]);
  await engine.executeRaw("DELETE FROM pages WHERE source_id=ANY($1::text[]) OR (source_id='default' AND slug='notes/core-policy-default')", [[sourceId, otherSource]]);
  await engine.executeRaw('UPDATE sources SET archived=false WHERE id=ANY($1::text[])', [[sourceId, otherSource]]);
  await engine.setConfig('memory.core.enabled', 'true');
  await engine.setConfig('memory.core.max_chars', '4000');
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previousHome;
});

test('常驻背景遵守客户端的单来源和联合授权，空授权不扩大范围', async () => {
  await page('notes/core-policy-default', '默认来源限定内容', 'default');
  await page('notes/local', '当前来源内容');
  const pack = async (allowedSources?: string[]) => {
    const result = await dispatchToolCall(engine, 'context_pack', { session_id: randomUUID() }, {
      remote: true, transport: 'http', sourceId,
      auth: { token: 'test-only', clientId: 'restricted-client', scopes: ['read'], sourceId, ...(allowedSources ? { allowedSources } : {}) },
    });
    expect(result.isError).not.toBe(true);
    return JSON.stringify(result);
  };
  for (const allowed of [undefined, [], [sourceId]]) {
    const result = await pack(allowed);
    expect(result).toContain('当前来源内容');
    expect(result).not.toContain('默认来源限定内容');
  }
  expect(await pack([sourceId, 'default'])).toContain('默认来源限定内容');
});

test('归档来源、隔离页与正文里的私密事实不进入远程常驻背景', async () => {
  await page('notes/quarantined', '隔离页不应出现', sourceId, { quarantine: true });
  await page('notes/fence', `公开说明\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | 公开事实 | fact | 1.0 | world | medium | 2026-01-01 | | s | |\n| 2 | 私密事实标记 | fact | 1.0 | private | medium | 2026-01-01 | | s | |\n<!--- gbrain:facts:end -->`);
  const result = await loadCoreBlock(engine, { sessionSourceId: sourceId, excludePrivate: true });
  expect(result.text).toContain('公开事实');
  expect(result.text).not.toContain('私密事实标记');
  expect(result.text).not.toContain('隔离页不应出现');
  await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
  expect((await core()).text).not.toContain('公开事实');
});

test.each([['喝绿茶', '喝绿茶'], ['Use plain English.', 'use plain english']])('遗忘 %s 后，常驻背景和助手系统上下文立即移除 %s', async (fact, rendered) => {
  const saved = await remember(fact);
  await page('notes/preference', `保留这条有效约定\n${rendered}`);
  expect((await core()).text).toContain(rendered);
  await forget(saved.id);
  expect((await core()).text).not.toContain(rendered);
  expect(await sessionMemoryPreface(engine, sourceId)).not.toContain(rendered);
  expect((await core()).text).toContain('保留这条有效约定');
});

test('同文遗忘按来源、对象和可见性隔离，不能误删其他对象的有效背景', async () => {
  await page('people/alice', '喜欢蓝色');
  await page('people/bob', '喜欢蓝色');
  const saved = await remember('喜欢蓝色', { entity: 'people/alice' });
  await remember('喜欢蓝色', { entity: 'people/bob' });
  await forget(saved.id);
  const result = await core();
  expect(result.pages.some(p => p.slug === 'people/alice')).toBe(false);
  expect(result.pages.some(p => p.slug === 'people/bob')).toBe(true);
  await remember('偏爱清茶', { visibility: 'private' });
  const privateFact = await remember('偏爱清茶', { visibility: 'private' });
  await page('notes/public', '偏爱清茶');
  await page('notes/private', '偏爱清茶', sourceId, { visibility: 'private' });
  await page('notes/foreign', '偏爱清茶', otherSource);
  await forget(privateFact.id);
  expect((await core()).pages.some(p => p.slug === 'notes/public')).toBe(true);
  expect((await core()).pages.some(p => p.slug === 'notes/private')).toBe(false);
  expect((await loadCoreBlock(engine, { sessionSourceId: otherSource })).text).toContain('偏爱清茶');
});

test('更正请求重发沿用成功结果，不重复写入；已撤回的新事实不能被重发复活', async () => {
  const old = await remember('报告采用繁体');
  const changed = await remember('报告采用简体', { replaces: old.id });
  const repeated = await remember('报告采用简体', { replaces: old.id });
  expect(repeated).toMatchObject({ id: changed.id, status: 'duplicate' });
  await forget(changed.id);
  expect(await rejection(remember('报告采用简体', { replaces: old.id }))).toContain('fact_withdrawn');
});

test('两个客户端同时纠正同一条事实，只接受一条新说法', async () => {
  const old = await remember('验收计划在周一执行');
  const results = await Promise.allSettled([
    remember('验收计划改到周二', { replaces: old.id }),
    remember('验收计划改到周三', { replaces: old.id }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(String(rejected.reason)).toContain('target_superseded');
  const active = await engine.executeRaw("SELECT id FROM facts WHERE source_id=$1 AND expired_at IS NULL AND fact LIKE '验收计划%'", [sourceId]);
  expect(active).toHaveLength(1);
});

test('公开页中本机可见的私密事实也遵守遗忘，正文仍然保留', async () => {
  const saved = await remember('家住成都', { visibility: 'private' });
  await page('notes/mixed', '公开正文\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | 家住成都 | fact | 1.0 | private | medium | 2026-01-01 | | s | |\n<!--- gbrain:facts:end -->');
  expect((await core()).text).toContain('家住成都');
  await forget(saved.id);
  expect((await core()).text).not.toContain('家住成都');
  expect((await core()).text).toContain('公开正文');
});

test('遗忘后撤回账本暂时写入失败，重试仍能补齐，原句不能重新记住', async () => {
  const saved = await remember('偏爱红茶');
  await engine.executeRaw("CREATE OR REPLACE FUNCTION test_reject_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'withdrawal write failed'; END;$$");
  await engine.executeRaw('CREATE TRIGGER test_reject_withdrawal BEFORE INSERT ON fact_withdrawals FOR EACH ROW EXECUTE FUNCTION test_reject_withdrawal()');
  let failure: unknown;
  try { await forget(saved.id); }
  catch (error) { failure = error; }
  finally {
    await engine.executeRaw('DROP TRIGGER test_reject_withdrawal ON fact_withdrawals');
    await engine.executeRaw('DROP FUNCTION test_reject_withdrawal()');
  }
  expect(String(failure)).toContain('withdrawal write failed');
  await forget(saved.id);
  expect(await rejection(remember('偏爱红茶'))).toContain('fact_withdrawn');
});

test('到期和已替换的事实退出常驻背景，有效的新说法保留', async () => {
  const expired = await remember('暂住成都');
  const old = await remember('报告采用英文');
  await page('notes/current', '暂住成都\n报告采用英文\n报告采用中文');
  await engine.executeRaw("UPDATE facts SET valid_until=now()-interval '1 second' WHERE id=$1", [expired.id]);
  await remember('报告采用中文', { replaces: old.id });
  const result = await core();
  expect(result.text).not.toContain('暂住成都');
  expect(result.text).not.toContain('报告采用英文');
  expect(result.text).toContain('报告采用中文');
});

test('原生记忆派生页的事实失效时，即使正文改写也不会绕过有效性检查', async () => {
  const fact = await remember('项目状态有效');
  const conversation = randomUUID();
  const message = randomUUID();
  await page(`conversations/pmbrain/${conversation}/memory`, '改写后的项目状态', sourceId, {
    pmbrain_memory: true, pmbrain_memory_fact_ids: [Number(fact.id)],
    source_ref: `pmbrain://conversations/${conversation}/${message}`, id: `${message}-${'a'.repeat(64)}`,
  });
  expect((await core()).text).toContain('改写后的项目状态');
  await engine.executeRaw("UPDATE facts SET valid_until=now()-interval '1 second' WHERE id=$1", [fact.id]);
  expect((await core()).text).not.toContain('改写后的项目状态');
});

test('撤回规则读取失败时报告错误，不把未过滤的常驻内容交给模型', async () => {
  await page('notes/failure', '未经检查的记忆');
  const executeRaw = engine.executeRaw;
  engine.executeRaw = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('fact_withdrawals')) throw new Error('withdrawal read failed');
    return executeRaw.call(engine, sql, params);
  }) as BrainEngine['executeRaw'];
  try { expect(await rejection(core())).toContain('withdrawal read failed'); }
  finally { engine.executeRaw = executeRaw; }
});

test('外部记忆由助手明确纠正后，各客户端读到新说法，遗忘后新会话不再读到', async () => {
  await page('projects/policy-project', '共享记忆验收项目');
  const first = await remember('验收项目报告采用英文', { entity: 'projects/policy-project' });
  const now = new Date().toISOString();
  const id = randomUUID();
  store.save({ id, title: '共享记忆验收', model: 'ollama:test', knowledge: true, sourceId, createdAt: now, updatedAt: now,
    messages: [{ id: randomUUID(), role: 'user', text: '请更正记忆，验收项目报告采用中文', createdAt: now, status: 'complete' }] });
  const handlers = nativeMemoryHandlers(engine, sourceId, id, { store, tasks: {} as never }, () => 1, new Map());
  expect(workbenchMemoryTools(store.get(id).messages[0].text).some(t => t.name === 'memory_remember')).toBe(true);
  const restored = await handlers.get('memory_recall')!.execute({ query: '验收项目报告' }, new AbortController().signal) as { facts: Array<{ fact_id: number; entity: string }> };
  expect(restored.facts).toContainEqual(expect.objectContaining({ fact_id: Number(first.id), entity: 'projects/policy-project' }));
  const changed = await handlers.get('memory_remember')!.execute({ fact: '验收项目报告采用中文', kind: 'preference', entity: 'projects/policy-project', replaces: first.id }, new AbortController().signal) as { id: number };
  for (const clientId of ['codex-fixture', 'claude-fixture', 'workbuddy-fixture', 'chatgpt-fixture']) {
    const result = await dispatchToolCall(engine, 'recall', { grep: '验收项目报告' }, { sourceId, remote: true, transport: 'http', auth: { token: 'test-only', clientId, scopes: ['read'], sourceId, allowedSources: [sourceId] } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('验收项目报告采用中文');
    expect(JSON.stringify(result)).not.toContain('验收项目报告采用英文');
  }
  await forget(String(changed.id));
  const recalled = await operationsByName.recall.handler(ctx(), { grep: '验收项目报告' });
  expect(JSON.stringify(recalled)).not.toContain('验收项目报告采用中文');
});
