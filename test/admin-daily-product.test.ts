import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { normalizeConnectorCookieInput } from '../src/core/connectors/cookie-input.ts';
import {
  connectorProbeError,
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
  setChronicleEnabled,
  setConnectorAutoSync,
  suggestSamePersonPairs,
} from '../src/commands/admin-daily-product.ts';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('自动化能力按用户任务归位', () => {
  test('不再展示日常四页，只把需要人工处理的结果放到工作台', () => {
    const app = read('admin/src/App.tsx');
    const waiting = read('admin/src/pages/Waiting.tsx');
    const connectors = read('admin/src/pages/Connectors.tsx');
    const chronicle = read('admin/src/pages/Chronicle.tsx');
    const settings = read('admin/src/pages/Settings.tsx');
    expect(app).not.toContain("title: '日常'");
    expect(app).toContain("{ page: 'dashboard' as Page, label: '总体概览' }");
    expect(app).toContain("title: '工作台'");
    expect(app).toContain("page: 'import', label: '知识工作台'");
    expect(app).toContain("page: 'waiting', label: '待我处理'");
    expect(app).toContain("page: 'data', label: '知识库'");
    expect(app).toContain("page: 'chronicle', label: '时间线'");
    expect(app).toContain("page: 'connectors', label: '数据连接'");
    expect(app).not.toContain("label: '人物关联'");
    expect(waiting).toContain('自动检查');
    expect(waiting).toContain('重新检查');
    expect(waiting).not.toContain('立即扫描');
    expect(waiting).toContain('已完成');
    expect(waiting).toContain('忽略');
    expect(waiting).toContain('可能是同一个人');
    expect(waiting).toContain('是同一个人');
    expect(waiting).toContain('不是同一个人');
    expect(waiting).not.toContain('Open Loop');
    expect(waiting).not.toContain('open_loops');
    expect(connectors).toContain('高级设置');
    expect(connectors).toContain('自动同步');
    expect(connectors).toContain('未连接');
    expect(connectors).toContain('已连接');
    expect(connectors).toContain('Request Headers');
    expect(connectors).toContain('复制整行 Cookie:');
    expect(connectors).toContain('打不开回跳页？改用粘贴网址');
    expect(connectors).not.toContain('console.log');
    expect(connectors).not.toContain('client_secret');
    expect(chronicle).toContain('时间线');
    expect(chronicle).toContain('设置 → 自动维护');
    expect(chronicle).not.toContain('开启时间记忆');
    expect(chronicle).not.toContain('整理历史记录');
    expect(chronicle).not.toContain('Life Chronicle');
    expect(chronicle).not.toContain('backfill');
    expect(chronicle).not.toContain('年表回填');
    expect(settings).toContain('自动生成时间线');
    expect(settings).toContain('整理历史时间线');
  });

  test('Admin 路由继续包现有能力，不另写一套合并逻辑', () => {
    const routes = read('src/commands/pmbrain-admin-routes.ts');
    const helper = read('src/commands/admin-daily-product.ts');
    expect(routes).toContain("app.post('/admin/api/waiting/scan'");
    expect(routes).toContain("app.get('/admin/api/people'");
    expect(routes).toContain("app.post('/admin/api/people/merge'");
    expect(routes).toContain("app.post('/admin/api/connectors/auto-sync'");
    expect(routes).toContain("app.post('/admin/api/chronicle/settings'");
    expect(routes).toContain("app.post('/admin/api/chronicle/history'");
    expect(helper).toContain('runLoopsScan');
    expect(helper).toContain('linkEntityIdentity');
    expect(helper).not.toContain('auto merge by chinese name');
  });
});

describe('连接器登录信息使用用户复制的整行 Cookie', () => {
  test('既接受整行 Cookie，也兼容原来只复制值的用法', () => {
    expect(normalizeConnectorCookieInput('Cookie: a=1; b=2')).toBe('a=1; b=2');
    expect(normalizeConnectorCookieInput('cookie : a=1; b=2')).toBe('a=1; b=2');
    expect(normalizeConnectorCookieInput('a=1; b=2')).toBe('a=1; b=2');
  });

  test('粘贴多行请求头时只提取 Cookie，不把其他请求头发给第三方', () => {
    expect(normalizeConnectorCookieInput('Accept: */*\r\nCookie: session=x; device=y\r\nReferer: https://chatgpt.com/')).toBe('session=x; device=y');
    expect(normalizeConnectorCookieInput('Cookie:   ')).toBe('');
  });

  test('凭证、拦截、网络和接口变化分别告诉用户', () => {
    expect(connectorProbeError('chatgpt', { ok: false, kind: 'unauthorized', detail: '401' })).toContain('登录信息已失效');
    expect(connectorProbeError('chatgpt', { ok: false, kind: 'forbidden_fingerprint', detail: '403' })).toContain('Cloudflare');
    expect(connectorProbeError('chatgpt', { ok: false, kind: 'network', detail: 'timeout' })).toContain('网络');
    expect(connectorProbeError('chatgpt', { ok: false, kind: 'drift', detail: 'shape' })).toContain('接口发生了变化');
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

  test('设置开关只写现有配置键', async () => {
    expect(await setConnectorAutoSync(engine, 'chatgpt', true)).toEqual({ ok: true, provider: 'chatgpt', enabled: true });
    expect(await engine.getConfig('connectors.chatgpt.auto_sync')).toBe('true');
    expect(await setChronicleEnabled(engine, true)).toEqual({ ok: true, enabled: true });
    expect(await engine.getConfig('auto_chronicle')).toBe('true');
    expect(await setChronicleEnabled(engine, false)).toEqual({ ok: true, enabled: false });
    expect(await engine.getConfig('auto_chronicle')).toBe('false');
  });
});
