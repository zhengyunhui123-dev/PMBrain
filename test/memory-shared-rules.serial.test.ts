/**
 * 产品经理可读的测试说明：
 *
 * 这一组确认外部 AI 和知识助手用的是同一套长期记忆，并且存法和 GBrain 一致。
 * 1. 用户明确忘掉一句话后，原句不能再记住；没指定对象时，换任何对象也不行。换一种说法可以。升级旧库时，仍有效的同文也会失效；只是被新说法替换过的旧说法不会被永久忘掉。
 * 2. 纠正要用原来的事实编号替换，旧说法退出有效记忆，但不是被永久忘掉。编号不对、对象不对、或那条已经忘掉，都会拒绝。
 * 3. 同一句再说一次，还是原来那一条，不会复制。
 * 4. 知识助手自动提炼时，已经忘掉的句子跳过，同一轮里的其他事实仍保存。
 * 5. 常驻背景默认关闭。打开后，会话开始、压缩后的上下文包和普通回答都会带上被标记的知识页正文，不带时间线。超长的页会被整页留在外面。远程会话看不到私密页。
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { loadCoreBlock, sessionMemoryPreface, setPageCore } from '../src/core/core-memory.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { operationsByName } from '../src/core/operations.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { MemoryWritebackUpdateRequestSchema } from '../shared/contracts/brain.ts';
import { WorkbenchMemoryCoordinator } from '../src/product/workbench/memory.ts';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes.ts';
import { WorkbenchStore } from '../src/product/workbench/store.ts';
import type { WorkbenchConversation, WorkbenchMessage } from '../shared/workbench.ts';

delete process.env.DATABASE_URL;
delete process.env.GBRAIN_DATABASE_URL;
delete process.env.PMBRAIN_DATABASE_URL;
delete process.env.GBRAIN_TEST_ALLOW_DATABASE_URL;

const root = mkdtempSync(join(tmpdir(), 'pmbrain-shared-memory-'));
const previousHome = process.env.PMBRAIN_HOME;
const engine = new PGLiteEngine();
const store = new WorkbenchStore(join(root, 'sessions'));
let coordinator: WorkbenchMemoryCoordinator;

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: null,
    remote: false,
    sourceId: 'default',
    dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  } as OperationContext;
}

async function remember(fact: string, extra: Record<string, unknown> = {}) {
  return operationsByName.remember!.handler(ctx(), {
    fact,
    provenance: '共享记忆测试',
    visibility: 'world',
    ...extra,
  }) as Promise<{ id: string; status: string; replaced_by_caller?: boolean }>;
}

async function activeFacts(fact: string) {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts WHERE fact = $1 AND expired_at IS NULL`,
    [fact],
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  process.env.PMBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'), { recursive: true });
  writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'all' } }));
  resetGateway();
  configureGateway({ env: {} });
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources(id, name) VALUES ('default', '默认') ON CONFLICT DO NOTHING`);
  await engine.setConfig('memory.auto_writeback', 'all');
  await engine.setConfig('facts.default_visibility', 'world');
  coordinator = new WorkbenchMemoryCoordinator(engine, store, async () => ({ id: 'task-shared', status: 'queued' } as never), async () => null);
}, 120_000);

afterAll(async () => {
  coordinator?.close();
  await engine.disconnect();
  resetGateway();
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previousHome;
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`);
  await engine.executeRaw(`DELETE FROM fact_withdrawals`);
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE frontmatter @> '{"always_load": true}'::jsonb`);
  await engine.setConfig('memory.core.enabled', 'false');
  await engine.unsetConfig('memory.core.max_chars');
});

test('设置合同允许单独打开常驻背景，空请求仍然无效', () => {
  expect(MemoryWritebackUpdateRequestSchema.safeParse({ core_enabled: true }).success).toBe(true);
  expect(MemoryWritebackUpdateRequestSchema.safeParse({ notice_shown: true }).success).toBe(true);
  expect(MemoryWritebackUpdateRequestSchema.safeParse({}).success).toBe(false);
});

test('忘掉的原句不能再记住，没指定对象时换对象也不行，换说法可以', async () => {
  const claim = '周报标题固定使用中文';
  const saved = await remember(claim);
  await operationsByName.forget!.handler(ctx(), { id: saved.id, reason: '用户要求忘掉' });
  await expect(remember(claim)).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('fact_withdrawn:') });
  await expect(remember(claim, { entity: 'people/memory-alice' })).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await activeFacts(claim)).toBe(0);
  const reworded = await remember('周报标题改为中英双语');
  expect(reworded.status).toBe('inserted');
  expect(await activeFacts('周报标题改为中英双语')).toBe(1);
});

test('指定对象后忘掉，只拦住这个对象，标点和大小写仍算同一句', async () => {
  const saved = await remember('Alice works at Acme.', { entity: 'people/memory-alice' });
  await operationsByName.forget!.handler(ctx(), { id: saved.id, reason: '对象撤回' });
  await expect(remember('alice works at acme', { entity: 'people/memory-alice' })).rejects.toMatchObject({ message: expect.stringContaining('fact_withdrawn:') });
  const other = await remember('alice works at acme', { entity: 'people/memory-bob' });
  expect(other.status).toBe('inserted');
});

test('纠正会替换指定事实，错误目标会被拒绝，替换本身不是永久忘掉', async () => {
  const original = await remember('周报用英文标题', { entity: 'people/memory-writer' });
  const replaced = await remember('周报用中文标题', { entity: 'people/memory-writer', replaces: original.id });
  expect(replaced.status).toBe('superseded');
  expect(replaced.replaced_by_caller).toBe(true);
  const recalled = await operationsByName.recall!.handler(ctx(), { limit: 20 }) as { facts: Array<{ fact: string }> };
  expect(recalled.facts.map(row => row.fact)).not.toContain('周报用英文标题');
  expect(recalled.facts.map(row => row.fact)).toContain('周报用中文标题');
  const restored = await remember('周报用英文标题', { entity: 'people/memory-writer' });
  expect(restored.status).toBe('inserted');

  await expect(remember('另一条新事实', { replaces: '999999' })).rejects.toMatchObject({ code: 'not_found' });
  const kept = await remember('对象不能换', { entity: 'people/memory-writer' });
  await expect(remember('对象被改掉了', { entity: 'people/memory-other', replaces: kept.id })).rejects.toMatchObject({
    message: expect.stringContaining('replaces_entity_mismatch:'),
  });
  expect(await activeFacts('对象被改掉了')).toBe(0);

  const doomed = await remember('这条稍后不能被替换', { entity: 'people/memory-writer' });
  await operationsByName.forget!.handler(ctx(), { id: doomed.id, reason: '忘掉后不能替换' });
  await expect(remember('用新说法替换已忘掉的事实', { entity: 'people/memory-writer', replaces: doomed.id })).rejects.toMatchObject({
    message: expect.stringContaining('target_withdrawn:'),
  });
  expect(await activeFacts('用新说法替换已忘掉的事实')).toBe(0);
});

test('同一句话再说一次仍是原来那一条', async () => {
  const first = await remember('重复记住不应新增');
  const second = await remember('重复记住不应新增');
  expect(second.status).toBe('duplicate');
  expect(second.id).toBe(first.id);
  expect(await activeFacts('重复记住不应新增')).toBe(1);
});

test('升级时，已经忘掉的句子会让仍有效的同文失效，被替换过的旧说法仍可保留', async () => {
  const forgotten = 'Weekly title stays in Chinese.';
  const superseded = 'Standup moves to Tuesday';
  await engine.executeRaw(
    `INSERT INTO facts(fact, source, source_id, visibility, expired_at, context)
     VALUES ($1, 'direct', 'default', 'world', now(), 'forgotten: 用户要求忘掉'),
            ($2, 'direct', 'default', 'world', now(), 'forgotten: superseded by fact #4')`,
    [forgotten, superseded],
  );
  await engine.executeRaw(
    `INSERT INTO facts(fact, source, source_id, visibility)
     VALUES ('weekly title stays in chinese', 'direct', 'default', 'world'),
            ($1, 'direct', 'default', 'world')`,
    [superseded],
  );
  await engine.setConfig('version', '135');
  await engine.setConfig('pmbrain.schema.version', '135');
  expect(await runMigrations(engine)).toMatchObject({ current: LATEST_VERSION });
  expect(await activeFacts('weekly title stays in chinese')).toBe(0);
  expect(await activeFacts(superseded)).toBe(1);
});

test('直接写回已忘掉的句子时，数据库会立刻把它标成失效', async () => {
  const claim = '导入不能复活已忘掉的句子';
  await engine.executeRaw(
    `INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash)
     VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1))`,
    [claim],
  );
  await engine.executeRaw(
    `INSERT INTO facts(fact, source, source_id, visibility) VALUES ($1, 'direct', 'default', 'world')`,
    [claim],
  );
  const rows = await engine.executeRaw<{ gone: boolean }>(
    `SELECT expired_at IS NOT NULL AS gone FROM facts WHERE fact = $1`,
    [claim],
  );
  expect(rows[0]?.gone).toBe(true);
  expect(await activeFacts(claim)).toBe(0);
});

test('知识助手跳过已忘掉的句子，同一轮的其他事实仍保存', async () => {
  const withdrawn = '助手不能再保存这句已忘掉的偏好';
  const kept = '助手仍要保存这句新的偏好';
  const saved = await remember(withdrawn);
  await operationsByName.forget!.handler(ctx(), { id: saved.id, reason: '助手跳过' });
  const message: WorkbenchMessage = {
    id: randomUUID(), role: 'user', text: '以后周报先写结论，并且不要再使用旧标题。', createdAt: new Date().toISOString(), status: 'complete',
  };
  const conversation: WorkbenchConversation = {
    id: randomUUID(), title: '测试', model: 'ollama:test', knowledge: false, sourceId: 'default', createdAt: message.createdAt, updatedAt: message.createdAt, messages: [message],
  };
  message.memory = await coordinator.capture(conversation, message);
  store.save(conversation);
  const { runWorkbenchMemoryTask } = await import('../src/product/workbench/memory.ts');
  const finished = await runWorkbenchMemoryTask(engine, {
    root: store.root, conversationId: conversation.id, messageId: message.id, hash: message.memory!.hash, sourceId: 'default',
  }, new AbortController().signal, {
    extract: (async () => [
      { fact: withdrawn, kind: 'preference', entity_slug: null, embedding: null },
      { fact: kept, kind: 'preference', entity_slug: null, embedding: null },
    ]) as never,
  });
  expect(finished.status).toBe('completed');
  expect(await activeFacts(withdrawn)).toBe(0);
  expect(await activeFacts(kept)).toBe(1);
});

test('常驻背景默认关闭；打开后进入上下文和回答，时间线不进入，超限整页留出，远程不读私密页', async () => {
  await engine.putPage('notes/core-truth', {
    type: 'concept', title: '工作约定', compiled_truth: '驻留真理：先写结论。', timeline: '时间线不该出现在常驻背景', frontmatter: { always_load: true },
  });
  await engine.putPage('notes/core-private', {
    type: 'concept', title: '私密约定', compiled_truth: '私密常驻不给远程。', timeline: '', frontmatter: { always_load: true, visibility: 'private', private: true },
  });
  await engine.putPage('notes/core-long', {
    type: 'concept', title: '过长约定', compiled_truth: `过长标记${'长'.repeat(2000)}`, timeline: '', frontmatter: { always_load: true, core_priority: 200 },
  });
  const off = await loadCoreBlock(engine, { sessionSourceId: 'default', excludePrivate: false });
  expect(off.enabled).toBe(false);
  expect(off.text).toBe('');
  const packedOff = await operationsByName.context_pack!.handler(ctx(), { session_id: 'session-off' }) as { text: string; core_enabled: boolean };
  expect(packedOff.core_enabled).toBe(false);
  expect(packedOff.text).not.toContain('驻留真理');
  expect(await sessionMemoryPreface(engine, 'default')).toBe('');

  await engine.setConfig('memory.core.enabled', 'true');
  await engine.setConfig('memory.core.max_chars', '500');
  const preface = await sessionMemoryPreface(engine, 'default');
  expect(preface).toContain('驻留真理：先写结论。');
  expect(preface).toContain('私密常驻不给远程。');
  expect(preface).not.toContain('时间线不该出现在常驻背景');
  expect(preface).not.toContain('过长标记');
  expect(preface).toContain('core truncated:');
  const remote = await operationsByName.context_pack!.handler(ctx({ remote: true }), { session_id: 'session-on' }) as { text: string; core_enabled: boolean };
  expect(remote.core_enabled).toBe(true);
  expect(remote.text).toContain('驻留真理：先写结论。');
  expect(remote.text).not.toContain('私密常驻不给远程。');
  expect(remote.text).not.toContain('时间线不该出现在常驻背景');

  let system = '';
  const answer = knowledgeWorkbenchAnswer(engine, {
    search: (async () => ({ results: [] })) as never,
    recall: (async () => []) as never,
    answer: (async (input: { system?: string }) => { system = input.system ?? ''; return { text: '好的', stopReason: 'end' }; }) as never,
  });
  await answer({
    sourceId: 'default', conversationId: 'c-core', messageId: 'm-core', model: 'ollama:test', knowledge: false,
    messages: [{ id: 'm-core', role: 'user', text: '今天先做什么', createdAt: new Date().toISOString(), status: 'complete' }],
    signal: new AbortController().signal, progress() {}, onDelta() {}, onReplace() {},
  } as never);
  expect(system).toContain('驻留真理：先写结论。');
  expect(system).not.toContain('时间线不该出现在常驻背景');

  await setPageCore(engine, 'notes/core-truth', false, 'default');
  const removed = await loadCoreBlock(engine, { sessionSourceId: 'default', excludePrivate: true });
  expect(removed.text).not.toContain('驻留真理：先写结论。');
});
