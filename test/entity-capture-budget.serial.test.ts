/**
 * 产品经理能看懂的测试说明：
 * 用脚本代替付费模型，确认深度整理会：
 * 1. 看到已有实体就复用，不另建一页。
 * 2. 新人、公司、项目、概念写成对应类型。
 * 3. 长文尾部的人也能进入最后一块。
 * 4. 100 篇按文档算，不按分块算。
 * 5. 费用到顶、Token 到顶或没有用量时，停得正确，而且不把任务判失败。
 * 6. 本地 Ollama 金额是 0。失败重跑和停止都不会重复写人或继续写。
 * 这些写入走真实的页面表。脚本只决定模型回复，不跳过数据库。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runPhaseCaptureEntities } from '../src/core/cycle/capture-entities.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const databaseUrl = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
});

async function note(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
}

function promptOf(ctx: MinionJobContext): string {
  const data = ctx.data as { prompt?: string };
  return data.prompt ?? '';
}

test('已有实体放进候选，脚本复用原页，不创建第二个人', async () => {
  await engine.putPage('people/张三', {
    type: 'person', title: '张三', compiled_truth: '张三已经有页。', timeline: '',
    frontmatter: { aliases: ['张老师'] },
  }, { sourceId: 'vault' });
  await note('notes/work', '张老师今天来开会，讨论了新的合作。');
  let prompt = '';
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async ctx => {
      prompt = promptOf(ctx);
      if (!prompt.includes('people/张三')) throw new Error('候选里应该有已有人物');
      return { tokens: { in: 20, out: 5 } };
    },
  });
  expect(result.status).toBe('ok');
  expect(prompt).toContain('people/张三');
  expect(prompt).toContain('person');
  expect(prompt).toContain('张三');
  expect(prompt).toContain('张老师');
  expect(prompt).toContain('绝对不能把未知类型写成 concept');
  const people = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'vault' AND type = 'person'`,
  );
  expect(people.map(row => row.slug)).toEqual(['people/张三']);
}, 60_000);

test('新人、公司、项目和概念按类型落库，新别名复用已有公司', async () => {
  await engine.putPage('companies/xinghe', {
    type: 'company', title: '星河公司', compiled_truth: '已有公司页。', timeline: '', frontmatter: {},
  }, { sourceId: 'vault' });
  await note('notes/deal', '李四代表星河公司推进灯塔项目，并形成潮汐方法。星河实验室是同一家公司。');
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async ctx => {
      const prompt = promptOf(ctx);
      expect(prompt).toContain('companies/xinghe');
      await engine.putPage('people/li-si', {
        type: 'person', title: '李四', compiled_truth: '李四代表星河公司。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      await engine.putPage('companies/xinghe', {
        type: 'company', title: '星河公司', compiled_truth: '已有公司页。别名星河实验室。', timeline: '',
        frontmatter: { aliases: ['星河实验室'] },
      }, { sourceId: 'vault' });
      await engine.putPage('projects/lighthouse', {
        type: 'project', title: '灯塔项目', compiled_truth: '灯塔项目由李四推进。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      await engine.putPage('concepts/tide', {
        type: 'concept', title: '潮汐方法', compiled_truth: '潮汐方法来自这次合作。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      return { tokens: { in: 30, out: 12 } };
    },
  });
  expect(result.status).toBe('ok');
  const rows = await engine.executeRaw<{ slug: string; type: string }>(
    `SELECT slug, type FROM pages WHERE source_id = 'vault' AND slug IN ('people/li-si', 'companies/xinghe', 'projects/lighthouse', 'concepts/tide') ORDER BY slug`,
  );
  expect(rows).toEqual([
    { slug: 'companies/xinghe', type: 'company' },
    { slug: 'concepts/tide', type: 'concept' },
    { slug: 'people/li-si', type: 'person' },
    { slug: 'projects/lighthouse', type: 'project' },
  ]);
  const companies = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'vault' AND type = 'company'`,
  );
  expect(Number(companies[0]?.n)).toBe(1);
}, 60_000);

test('长文尾部和页面额度按源文档计算', async () => {
  const tail = '尾部实体周舟只出现在最后';
  await note('notes/next', '第二篇资料不应该在这一轮送给模型。');
  await note('notes/long', `${'甲'.repeat(9000)}${tail}`);
  const prompts: string[] = [];
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    maxPages: 1,
    handler: async ctx => {
      prompts.push(promptOf(ctx));
      return { tokens: { in: 5, out: 1 } };
    },
  });
  expect(result.status).toBe('ok');
  expect(result.details.pages_submitted).toBe(1);
  expect(result.details.pages_remaining).toBe(1);
  expect(Number(result.details.chunks_submitted)).toBeGreaterThan(1);
  expect(prompts.at(-1)).toContain(tail);
  expect(prompts.every(prompt => prompt.includes('notes/long'))).toBe(true);
}, 60_000);

test('费用到上限后停止新的模型请求，已完成结果保留，任务不失败', async () => {
  await note('notes/a', '第一篇资料足够长，用来识别实体。');
  await note('notes/b', '第二篇资料足够长，用来识别实体。');
  await note('notes/c', '第三篇资料足够长，用来识别实体。');
  let calls = 0;
  const result = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: {
      maxPages: 10,
      costCapCny: 0.01,
      inputPriceCnyPerMillion: 10,
      outputPriceCnyPerMillion: 10,
    },
    handler: async () => {
      calls += 1;
      await engine.putPage('people/first-only', {
        type: 'person', title: '只写一次', compiled_truth: '第一轮已经写好。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      return { tokens: { in: 1000, out: 1000 } };
    },
  });
  expect(result.status).toBe('ok');
  expect(calls).toBe(1);
  expect(result.details.budget_stop).toBe('cost');
  expect(result.details.pages_remaining).toBe(2);
  expect(result.details.cost_cny).toBe(0.02);
  expect(result.details.cost_cap_cny).toBe(0.01);
  const people = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/first-only'`,
  );
  expect(Number(people[0]?.n)).toBe(1);
}, 60_000);

test('Ollama 不记人民币，没有价格时改按 Token 停，没有用量时只按页数停', async () => {
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await note(slug, `${slug} 的正文足够参与实体识别。`);
  }
  let ollamaCalls = 0;
  const ollama = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: {
      ollama: true,
      maxPages: 3,
      costCapCny: 0.01,
      inputPriceCnyPerMillion: 10_000,
      outputPriceCnyPerMillion: 10_000,
    },
    handler: async () => {
      ollamaCalls += 1;
      return { tokens: { in: 1000, out: 1000 } };
    },
  });
  expect(ollama.status).toBe('ok');
  expect(ollamaCalls).toBe(3);
  expect(ollama.details.cost_cny).toBe(0);
  expect(ollama.details.budget_stop).toBeNull();

  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await note(slug, `${slug} 的正文足够参与实体识别。`);
  }
  let tokenCalls = 0;
  const tokens = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: {
      maxPages: 10,
      costCapCny: 0.01,
      inputPriceCnyPerMillion: null,
      outputPriceCnyPerMillion: null,
      maxInputTokens: 1500,
      maxOutputTokens: 200_000,
    },
    handler: async () => {
      tokenCalls += 1;
      return { tokens: { in: 1000, out: 10 } };
    },
  });
  expect(tokens.status).toBe('ok');
  expect(tokenCalls).toBe(2);
  expect(tokens.details.budget_stop).toBe('tokens');
  expect(tokens.details.cost_cny).toBeNull();

  await resetPgliteState(engine as PGLiteEngine);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
  await engine.setConfig('version', '130');
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  for (const slug of ['notes/a', 'notes/b', 'notes/c']) {
    await note(slug, `${slug} 的正文足够参与实体识别。`);
  }
  let blindCalls = 0;
  const blind = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    budget: { maxPages: 2, maxInputTokens: 1, costCapCny: 0.01, inputPriceCnyPerMillion: 10, outputPriceCnyPerMillion: 10 },
    handler: async () => {
      blindCalls += 1;
      return { tokens: { missing: true } };
    },
  });
  expect(blind.status).toBe('ok');
  expect(blindCalls).toBe(2);
  expect(blind.details.budget_stop).toBe('pages');
  expect(blind.details.input_tokens).toBe(0);
  expect(blind.details.cost_cny).toBeNull();
  expect(blind.details.usage_missing).toBe(true);
}, 60_000);

test('失败重跑不重复建人，停止后不再写下一份', async () => {
  await note('notes/work', '张三在这里被提到，正文足够长。');
  let calls = 0;
  const first = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      calls += 1;
      await engine.putPage('people/张三', {
        type: 'person', title: '张三', compiled_truth: '张三只应有一页。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      if (calls < 4) throw new Error('模型这次失败');
      return { tokens: { in: 3, out: 2 } };
    },
  });
  expect(first.status).toBe('fail');
  expect(calls).toBe(3);
  const second = await runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    handler: async () => {
      calls += 1;
      await engine.putPage('people/张三', {
        type: 'person', title: '张三', compiled_truth: '张三只应有一页。', timeline: '', frontmatter: {},
      }, { sourceId: 'vault' });
      return { tokens: { in: 3, out: 2 } };
    },
  });
  expect(second.status).toBe('ok');
  expect(calls).toBe(4);
  const people = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'vault' AND slug = 'people/张三'`,
  );
  expect(Number(people[0]?.n)).toBe(1);
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  await runByMentionCore(engine, { sourceIdFilter: 'vault', quiet: true });
  const links = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'notes/work' AND t.slug = 'people/张三' AND l.link_source = 'mentions'`,
  );
  expect(Number(links[0]?.n)).toBe(1);

  await note('notes/keep', '这份会在停止前写完，正文足够长。');
  await note('notes/later', '这份在停止后不能再送给模型，正文足够长。');
  const controller = new AbortController();
  let stoppedCalls = 0;
  await expect(runPhaseCaptureEntities(engine, {
    sourceId: 'vault',
    signal: controller.signal,
    handler: async () => {
      stoppedCalls += 1;
      if (stoppedCalls > 1) {
        await engine.putPage('people/next', {
          type: 'person', title: '不该出现', compiled_truth: '停止后不应再写。', timeline: '', frontmatter: {},
        }, { sourceId: 'vault' });
      } else {
        await engine.putPage('people/kept', {
          type: 'person', title: '已完成', compiled_truth: '停止前这一页保留。', timeline: '', frontmatter: {},
        }, { sourceId: 'vault' });
        controller.abort();
      }
      return { tokens: { in: 1, out: 1 } };
    },
  })).rejects.toThrow();
  expect(stoppedCalls).toBe(1);
  const kept = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/kept'`,
  );
  const leaked = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE slug = 'people/next'`,
  );
  expect(Number(kept[0]?.n)).toBe(1);
  expect(Number(leaked[0]?.n)).toBe(0);
}, 60_000);
