// 这份测试用隔离的临时数据库，不碰正式知识库。
// 已有项目叫「个人知识库 Wiki 索引」。同一批再提交名称相近的新项目和一个正常人物。
// 相近名称应留下来核对，不能自动合并，也不能挡住人物保存。有出处证据后才能另建新页。
// 接着模拟执行锁被换掉：旧执行不能再写入，新执行只补还没保存的实体，已保存的人不重复。
// 普通校验错误只留在当前实体；数据库或权限错误仍然停止整批。
import { expectRejection } from './helpers/await-rejection.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ToolCtx, ToolDef } from '../src/core/minions/types.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { entityIngestTools, type EntityIngestContext } from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const previous = process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME = mkdtempSync(join(tmpdir(), 'pmbrain-identity-batch-'));
const url = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;
const body = '李四整理了个人知识库 Wiki 索引。Wiki 索引只汇总目录链接，不替代原来的项目页。';
const context: EntityIngestContext = {
  slug: 'notes/meeting', sourceId: 'default', body, chunkBody: body,
  compact_contract: true, batch_capture: true, quickEntitiesOnly: true,
};
const variant = 'projects/wiki-suoyin';
const person = 'people/lisi';
const variantContent = '---\ntitle: Wiki 索引\ntype: project\n---\nWiki 索引只汇总目录链接。[Source: notes/meeting]';
const personContent = '---\ntitle: 李四\ntype: person\n---\n李四整理了个人知识库 Wiki 索引。[Source: notes/meeting]';
const relation = { from: person, to: variant, link_type: 'mentions', evidence: '李四整理了个人知识库 Wiki 索引' };

beforeAll(async () => {
  if (url) assertSafeE2eDatabaseUrl(url);
  engine = url ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(url ? { database_url: url } : {});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine as PGLiteEngine); });
afterAll(async () => {
  await engine.disconnect();
  if (previous === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previous;
}, 60_000);

const writer: ToolDef = {
  name: 'brain_put_page', description: 'write', input_schema: { type: 'object' }, idempotent: true,
  async execute(raw, ctx) {
    const input = raw as { slug: string; content: string };
    const parts = input.slug.split(':');
    const sourceId = parts.length > 1 ? parts.shift()! : 'default';
    const target = parts.join(':');
    const page = await ctx.engine.putPage(target, parseMarkdown(input.content, target), { sourceId });
    return { status: 'ok', slug: page.slug, source_id: page.source_id };
  },
};

async function prepare(lockToken?: string) {
  await engine.putPage(context.slug, { type: 'note', title: '原始记录', compiled_truth: body, frontmatter: {} });
  const [source] = await engine.executeRaw<{ id: number; incarnation: string }>(
    'SELECT p.id, s.incarnation::text incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1 AND p.source_id=$2',
    [context.slug, context.sourceId],
  );
  context.pageId = source!.id;
  context.sourceIncarnation = source!.incarnation;
  await engine.putPage('projects/wiki-index', { type: 'project', title: '个人知识库 Wiki 索引', compiled_truth: '已有索引页。', frontmatter: {} });
  const [job] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs(name,status,data,lock_token,lock_until) VALUES('subagent','active','{}'::jsonb,$1,now()+interval '5 minutes') RETURNING id`,
    [lockToken ?? null],
  );
  return job!.id;
}

async function runBatch(input: unknown, existingJobId?: number, token?: string) {
  const jobId = existingJobId ?? await prepare();
  const tool = entityIngestTools([writer], context).find(item => item.name === 'brain_capture_entities')!;
  const toolUseId = randomUUID();
  await engine.executeRaw(`INSERT INTO subagent_tool_executions(job_id,message_idx,tool_use_id,tool_name,input,status,schema_version,ordinal,gbrain_tool_use_id)
    VALUES($1,1,'batch','brain_capture_entities',$2::jsonb,'pending',2,0,$3::uuid)`, [jobId, JSON.stringify(input), toolUseId]);
  const ctx = { engine, jobId, toolUseId, remote: true as const, signal: new AbortController().signal, executionToken: token } as ToolCtx;
  return { tool, ctx, result: await tool.execute(input, ctx) as { status: string; receipt: string; pending_review: unknown[]; failed_items: unknown[]; deferred_relations: unknown[] } };
}

test('一个名称冲突不会挡住同批的正常人物，也不会按相近名称合并', async () => {
  const original = engine.executeRaw;
  let fullReads = 0;
  engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
    if (sql.includes('jsonb_agg') && (sql.includes('p.type = ANY') || sql.includes('p.type=ANY'))) fullReads += 1;
    return original.call(this, sql, params);
  }) as BrainEngine['executeRaw'];
  try {
    const input = { entities: [{ slug: variant, content: variantContent }, { slug: person, content: personContent }], relations: [relation] };
    const jobId = await prepare();
    fullReads = 0;
    const first = await runBatch(input, jobId);
    expect(first.result.status).toBe('ready');
    expect(first.result.pending_review).toHaveLength(1);
    expect(first.result.deferred_relations).toHaveLength(1);
    expect(JSON.parse(first.result.receipt).relations).toEqual([]);
    expect(await engine.getPage(person)).toMatchObject({ title: '李四' });
    expect(await engine.getPage(variant)).toBeNull();
    expect((await engine.getPage('projects/wiki-index'))?.title).toBe('个人知识库 Wiki 索引');
    expect((await engine.getPage('projects/wiki-index'))?.frontmatter.aliases ?? []).not.toContain('Wiki 索引');
    expect(fullReads).toBe(1);
    const again = await first.tool.execute(input, first.ctx) as { pending_review: unknown[] };
    expect(again.pending_review).toHaveLength(1);
    expect(await engine.executeRaw('SELECT id FROM pages WHERE slug=$1', [person])).toHaveLength(1);
    const confirmed = { entities: [{ slug: variant, content: variantContent, identity_confirmed: true, distinguishing_evidence: '只汇总目录链接' }], relations: [] };
    const created = await runBatch(confirmed);
    expect(created.result.pending_review).toEqual([]);
    expect(await engine.getPage(variant)).toMatchObject({ title: 'Wiki 索引' });
    expect(await engine.getPage('projects/wiki-index')).toMatchObject({ title: '个人知识库 Wiki 索引' });
    const reused = await runBatch({ entities: [{ slug: 'projects/wiki-index', content: '---\ntitle: 个人知识库 Wiki 索引\ntype: project\n---\n李四整理了个人知识库 Wiki 索引。[Source: notes/meeting]' }], relations: [] });
    expect(reused.result.pending_review).toEqual([]);
    expect(await engine.getPage(variant, { sourceId: 'default' })).toMatchObject({ title: 'Wiki 索引' });
    expect(await engine.executeRaw("SELECT id FROM pages WHERE title='Wiki 索引'")).toHaveLength(1);
  } finally {
    engine.executeRaw = original;
  }
});

test('旧执行丢锁后不能继续提交，新执行只补未完成的实体', async () => {
  const jobId = await prepare('token-a');
  const input = {
    entities: [
      { slug: person, content: personContent },
      { slug: 'projects/catalog', content: '---\ntitle: 目录链接\ntype: project\n---\n目录链接只汇总链接。[Source: notes/meeting]' },
    ],
    relations: [],
  };
  const original = engine.executeRaw;
  let receipts = 0;
  engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
    const rows = await original.call(this, sql, params);
    if (sql.includes("'pending'") && sql.includes('payload_hash') && ++receipts === 1) await original.call(this, 'UPDATE minion_jobs SET lock_token=$2 WHERE id=$1', [jobId, 'token-b']);
    return rows;
  }) as BrainEngine['executeRaw'];
  try {
    const tool = entityIngestTools([writer], context).find(item => item.name === 'brain_capture_entities')!;
    const toolUseId = randomUUID();
    await original.call(engine, `INSERT INTO subagent_tool_executions(job_id,message_idx,tool_use_id,tool_name,input,status,schema_version,ordinal,gbrain_tool_use_id)
      VALUES($1,1,'lease','brain_capture_entities',$2::jsonb,'pending',2,0,$3::uuid)`, [jobId, JSON.stringify(input), toolUseId]);
    const ctx = { engine, jobId, toolUseId, remote: true as const, signal: new AbortController().signal, executionToken: 'token-a' } as ToolCtx;
    await expectRejection(tool.execute(input, ctx), 'ingest_lease_lost');
    expect(await engine.getPage(person)).toMatchObject({ title: '李四' });
    expect(await engine.getPage('projects/catalog')).toBeNull();
    const resumed = await tool.execute(input, { ...ctx, executionToken: 'token-b' }) as { status: string; receipt: string };
    expect(resumed.status).toBe('ready');
    expect(JSON.parse(resumed.receipt).entities).toContain('default:projects/catalog');
    expect(await engine.executeRaw('SELECT id FROM pages WHERE slug=$1', [person])).toHaveLength(1);
    expect(await engine.getPage('projects/catalog')).toMatchObject({ title: '目录链接' });
  } finally {
    engine.executeRaw = original;
  }
});

test('普通保存错误留在当前实体，数据库和权限错误仍然停止整批', async () => {
  const input = {
    entities: [
      { slug: person, content: personContent },
      { slug: 'projects/catalog', content: '---\ntitle: 目录链接\ntype: project\n---\n目录链接没有出处。' },
    ],
    relations: [],
  };
  const jobId = await prepare();
  const tool = entityIngestTools([writer], context).find(item => item.name === 'brain_capture_entities')!;
  const toolUseId = randomUUID();
  await engine.executeRaw(`INSERT INTO subagent_tool_executions(job_id,message_idx,tool_use_id,tool_name,input,status,schema_version,ordinal,gbrain_tool_use_id)
    VALUES($1,1,'bad','brain_capture_entities',$2::jsonb,'pending',2,0,$3::uuid)`, [jobId, JSON.stringify(input), toolUseId]);
  const validation = await tool.execute(input, { engine, jobId, toolUseId, remote: true, signal: new AbortController().signal }) as { failed_items: Array<{ reason: string }>; pending_review: unknown[] };
  expect(validation.failed_items.map(item => item.reason).join(' ')).toContain('provenance');
  expect(validation.pending_review).toEqual([]);
  expect(await engine.getPage(person)).toMatchObject({ title: '李四' });
  expect(await engine.getPage('projects/catalog')).toBeNull();
  for (const message of ['permission denied', 'database connection failed']) {
    const failing: ToolDef = { ...writer, async execute(raw, ctx) {
      if (String((raw as { slug: string }).slug).includes('projects/second')) throw new Error(message);
      return writer.execute(raw, ctx);
    } };
    const stoppedJob = await prepare();
    const stoppedTool = entityIngestTools([failing], context).find(item => item.name === 'brain_capture_entities')!;
    const stoppedId = randomUUID();
    const stopped = { entities: [{ slug: person, content: personContent }, { slug: 'projects/second', content: '---\ntitle: 目录链接\ntype: project\n---\n目录链接只汇总链接。[Source: notes/meeting]' }], relations: [] };
    await engine.executeRaw(`INSERT INTO subagent_tool_executions(job_id,message_idx,tool_use_id,tool_name,input,status,schema_version,ordinal,gbrain_tool_use_id)
      VALUES($1,1,'stop','brain_capture_entities',$2::jsonb,'pending',2,0,$3::uuid)`, [stoppedJob, JSON.stringify(stopped), stoppedId]);
    await expectRejection(stoppedTool.execute(stopped, { engine, jobId: stoppedJob, toolUseId: stoppedId, remote: true, signal: new AbortController().signal }), message);
    expect(await engine.getPage(person)).not.toBeNull();
    expect(await engine.getPage('projects/second')).toBeNull();
  }
});
