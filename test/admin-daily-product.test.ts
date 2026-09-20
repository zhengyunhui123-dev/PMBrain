import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  corePersonName,
  entityIdFromTitle,
  friendlySourceLabel,
  isTitleStyleName,
  listPeopleWorkspace,
  loopOriginLabel,
  mergePeople,
  pairKey,
  presentWaitingItems,
  rejectPeoplePair,
  relativeDayLabel,
  suggestSamePersonPairs,
} from '../src/commands/admin-daily-product.ts';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('日常页给普通人看，不出现开发者术语', () => {
  test('四个页面不再要求用户填写 ID / slug / Open Loops / Chronicle', () => {
    const waiting = read('admin/src/pages/Waiting.tsx');
    const connectors = read('admin/src/pages/Connectors.tsx');
    const identity = read('admin/src/pages/Identity.tsx');
    const chronicle = read('admin/src/pages/Chronicle.tsx');
    expect(waiting).toContain('从哪里发现待办');
    expect(waiting).toContain('立即扫描');
    expect(waiting).toContain('已完成');
    expect(waiting).toContain('忽略');
    expect(waiting).not.toContain('Open Loop');
    expect(waiting).not.toContain('open_loops');
    expect(waiting).not.toContain('这不是收件箱已清零');
    expect(connectors).toContain('高级设置');
    expect(connectors).toContain('未连接');
    expect(connectors).toContain('已连接');
    expect(connectors).toContain('打不开回跳页？改用粘贴网址');
    expect(connectors).not.toContain('console.log');
    expect(connectors).not.toContain('client_secret');
    expect(identity).toContain('搜索人物');
    expect(identity).toContain('把选中的记录视为同一个人');
    expect(identity).toContain('可能是同一个人');
    expect(identity).toContain('确认关联');
    expect(identity).toContain('不是同一个人');
    expect(identity).not.toContain('身份组 ID');
    expect(identity).not.toContain('来源 ID');
    expect(identity).not.toContain('页面 slug');
    expect(chronicle).toContain('开启时间记忆');
    expect(chronicle).toContain('整理历史记录');
    expect(chronicle).not.toContain('Life Chronicle');
    expect(chronicle).not.toContain('backfill');
    expect(chronicle).not.toContain('年表回填');
  });

  test('Admin 路由继续包现有能力，不另写一套合并逻辑', () => {
    const routes = read('src/commands/pmbrain-admin-routes.ts');
    const helper = read('src/commands/admin-daily-product.ts');
    expect(routes).toContain("app.post('/admin/api/waiting/scan'");
    expect(routes).toContain("app.get('/admin/api/people'");
    expect(routes).toContain("app.post('/admin/api/people/merge'");
    expect(routes).toContain("app.post('/admin/api/chronicle/enable'");
    expect(routes).toContain("app.post('/admin/api/chronicle/history'");
    expect(helper).toContain('runLoopsScan');
    expect(helper).toContain('linkEntityIdentity');
    expect(helper).not.toContain('auto merge by chinese name');
  });
});

describe('人物关联只提示、不自动合并', () => {
  test('张三和张总在只有这两人时提示可能是同一个人', () => {
    const suggestions = suggestSamePersonPairs([
      { source_id: 'youdao', slug: 'people/zhang-san', title: '张三', source_label: '有道', entity_id: null },
      { source_id: 'meetings', slug: 'people/zhang-zong', title: '张总', source_label: '会议', entity_id: null },
    ]);
    expect(isTitleStyleName('张总')).toBe(true);
    expect(corePersonName('张三')).toBe('张三');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.reason).toBe('可能是同一个人');
  });

  test('同时存在张三和张明时，不会把张总自动判给其中任何一个', () => {
    const suggestions = suggestSamePersonPairs([
      { source_id: 'youdao', slug: 'people/zhang-san', title: '张三', source_label: '有道', entity_id: null },
      { source_id: 'gmail', slug: 'people/zhang-ming', title: '张明', source_label: 'Gmail', entity_id: null },
      { source_id: 'meetings', slug: 'people/zhang-zong', title: '张总', source_label: '会议', entity_id: null },
    ]);
    expect(suggestions.some((item) => item.left.title === '张总' || item.right.title === '张总')).toBe(false);
  });

  test('不同来源的同名会提示，已关联或已否定的不再提示', () => {
    const sameName = suggestSamePersonPairs([
      { source_id: 'youdao', slug: 'people/zhang-san', title: '张三', source_label: '有道', entity_id: null },
      { source_id: 'meetings', slug: 'people/zhang-san-2', title: '张三', source_label: '会议', entity_id: null },
    ]);
    expect(sameName).toHaveLength(1);
    const linked = suggestSamePersonPairs([
      { source_id: 'youdao', slug: 'people/zhang-san', title: '张三', source_label: '有道', entity_id: 'zhang-san' },
      { source_id: 'meetings', slug: 'people/zhang-zong', title: '张总', source_label: '会议', entity_id: null },
    ]);
    expect(linked).toHaveLength(0);
    const rejected = suggestSamePersonPairs(
      [
        { source_id: 'youdao', slug: 'people/zhang-san', title: '张三', source_label: '有道', entity_id: null },
        { source_id: 'meetings', slug: 'people/zhang-zong', title: '张总', source_label: '会议', entity_id: null },
      ],
      new Set([pairKey(
        { source_id: 'youdao', slug: 'people/zhang-san' },
        { source_id: 'meetings', slug: 'people/zhang-zong' },
      )]),
    );
    expect(rejected).toHaveLength(0);
  });

  test('中文姓名生成内部编号，页面不需要用户填写', () => {
    expect(entityIdFromTitle('Alice Chen', 'x')).toBe('alice-chen');
    expect(entityIdFromTitle('张三', 'youdao:people/zhang-san')).toMatch(/^p[a-f0-9]{16}$/);
    expect(friendlySourceLabel('youdao', 'youdao')).toBe('有道');
    expect(friendlySourceLabel('meetings', 'meetings')).toBe('会议');
    expect(friendlySourceLabel('gmail-ann', 'gmail-ann')).toBe('Gmail');
  });
});

describe('待办来源用普通人能看懂的话', () => {
  test('会议事项带上会议名，完成和忽略只改状态', () => {
    const items = presentWaitingItems([
      {
        id: 1,
        summary: '你答应周五发预算方案',
        last_activity_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        thread_id: 'meeting:12',
        page_title: '项目推进会',
        source_label: '会议',
      },
    ], Date.now());
    expect(items[0]?.title).toBe('你答应周五发预算方案');
    expect(items[0]?.meta).toContain('3 天前');
    expect(items[0]?.meta).toContain('来自会议《项目推进会》');
    expect(loopOriginLabel({ thread_id: 'connector:chatgpt:1' }).text).toBe('来自 AI 对话');
    expect(relativeDayLabel(new Date().toISOString())).toBe('今天');
  });
});

describe('人物搜索和确认关联走现有身份表', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    for (const table of ['entity_identities', 'content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'pages']) {
      await engine.executeRaw(`DELETE FROM ${table}`);
    }
    await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('youdao', '有道'), ('meetings', '会议')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    );
    await engine.putPage('people/zhang-san', {
      type: 'person', title: '张三', compiled_truth: '有道里的张三', timeline: '',
    }, { sourceId: 'youdao' });
    await engine.putPage('people/zhang-zong', {
      type: 'person', title: '张总', compiled_truth: '会议里的张总', timeline: '',
    }, { sourceId: 'meetings' });
  });

  test('按姓名能搜到不同来源的人，确认后才合成一张人物卡', async () => {
    const listed = await listPeopleWorkspace(engine, '张') as {
      people: Array<{ title: string; source_label: string; entity_id: string | null }>;
      suggestions: Array<{ left: { title: string }; right: { title: string } }>;
    };
    expect(listed.people.map((item) => `${item.source_label} · ${item.title}`).sort()).toEqual(['会议 · 张总', '有道 · 张三']);
    expect(listed.suggestions).toHaveLength(1);
    const merged = await mergePeople(engine, [
      { source_id: 'youdao', slug: 'people/zhang-san', title: '张三' },
      { source_id: 'meetings', slug: 'people/zhang-zong', title: '张总' },
    ]);
    expect(merged.entity_id).toBeTruthy();
    const after = await listPeopleWorkspace(engine, '张') as {
      people: Array<{ entity_id: string | null }>;
      suggestions: unknown[];
      groups: Array<{ name: string; members: unknown[] }>;
    };
    expect(after.suggestions).toHaveLength(0);
    expect(after.groups).toHaveLength(1);
    expect(after.people.every((item) => item.entity_id)).toBe(true);
  });

  test('点不是同一个人后不再提示这对记录', async () => {
    await rejectPeoplePair(
      engine,
      { source_id: 'youdao', slug: 'people/zhang-san' },
      { source_id: 'meetings', slug: 'people/zhang-zong' },
    );
    const listed = await listPeopleWorkspace(engine, '') as { suggestions: unknown[] };
    expect(listed.suggestions).toHaveLength(0);
  });
});
