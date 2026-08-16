/**
 * 产品经理可读的测试说明：
 *
 * 知识库这一页是数据库内容的可视化，不是另一套知识分类。
 * 这组测试确认三件事：
 * 1. 「事实」页读的是 facts 表，不是把页面类型叫 fact 的 Markdown。
 * 2. 笔记不再被误分进「原始与资料」；原始资料只放会话、会议、导入材料和参考来源。
 * 3. 打开一个知识页时，能看到挂在这个页面上的事实。
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAdminBrainOverview,
  getAdminBrainPageDetail,
  listAdminBrainFacts,
  listAdminBrainPages,
} from '../src/commands/admin-console.ts';
import { KNOWLEDGE_PAGE_VIEW_TYPES, knowledgePageViewTypes } from '../shared/knowledge-views.ts';

const brainDataSource = readFileSync(join(process.cwd(), 'admin/src/pages/BrainData.tsx'), 'utf8');

describe('Knowledge data classification and facts inventory', () => {
  test('notes belong with knowledge pages, not imported source material', () => {
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.materials).not.toContain('note');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.structured).toContain('note');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.structured).toContain('person');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.structured).toContain('company');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.structured).toContain('event');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.structured).toContain('project');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.materials).toContain('calendar-event');
    expect(KNOWLEDGE_PAGE_VIEW_TYPES.insights).toContain('idea');
    expect(knowledgePageViewTypes('facts')).toBeUndefined();
  });

  test('the knowledge page exposes a first-class facts tab', () => {
    expect(brainDataSource).toContain("['facts', '事实']");
    expect(brainDataSource).toContain('api.brainFacts');
    expect(brainDataSource).toContain('知识页、热记忆事实');
  });

  test('page view presets no longer dump notes into imported materials', async () => {
    const statements: string[] = [];
    const engine = {
      executeRaw: async (sql: string, params: unknown[] = []) => {
        statements.push(`${sql} :: ${JSON.stringify(params)}`);
        return sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
      },
    } as any;

    await listAdminBrainPages(engine, { view: 'materials' });
    expect(statements[0]).toContain('p.type IN');
    expect(statements[0]).toContain('conversation');
    expect(statements[0]).not.toContain('"note"');

    statements.length = 0;
    await listAdminBrainPages(engine, { view: 'structured' });
    expect(statements[0]).toContain('"note"');
    expect(statements[0]).toContain('"person"');
    expect(statements[0]).toContain('"company"');
    expect(statements[0]).toContain('"event"');
    expect(statements[0]).toContain('"project"');
  });

  test('facts inventory reads the facts table and hides expired rows by default', async () => {
    const statements: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('COUNT(*)')) return [{ total: 1 }];
        return [{
          id: 1,
          fact: '知识库应显示事实表',
          kind: 'belief',
          source_id: 'duwu',
          entity_slug: 'wiki/example',
          visibility: 'world',
          notability: 'medium',
          source: 'user said in this conversation',
          source_markdown_slug: 'wiki/example',
          confidence: 1,
          embedded: false,
          expired_at: null,
          created_at: '2026-08-16',
          updated_at: '2026-08-16',
        }];
      },
    } as any;

    const listed = await listAdminBrainFacts(engine, { q: '知识库' });
    expect(listed.total).toBe(1);
    expect(listed.rows[0]?.fact).toContain('事实表');
    expect(statements[0]).toContain('FROM facts f');
    expect(statements[0]).toContain('f.expired_at IS NULL');
    expect(statements[0]).toContain('f.fact ILIKE');
  });

  test('page detail includes facts attached by slug', async () => {
    const engine = {
      executeRaw: async (sql: string) => {
        if (sql.includes('FROM pages p')) {
          return [{
            id: 7,
            slug: 'wiki/example',
            title: 'Example',
            source_id: 'duwu',
            source_name: 'duwu',
            source_path: 'D:\\notes',
            type: 'note',
            page_kind: 'markdown',
            compiled_truth: '# Body',
            timeline: '',
            frontmatter: {},
            source_kind: 'file',
            source_uri: null,
            created_at: '2026-08-16',
            updated_at: '2026-08-16',
          }];
        }
        if (sql.includes('FROM takes')) {
          return [];
        }
        if (sql.includes('FROM facts')) {
          return [{
            id: 11,
            fact: '挂在这个页面上的事实',
            kind: 'fact',
            visibility: 'world',
            notability: 'medium',
            entity_slug: 'wiki/example',
            source: 'remember',
            source_markdown_slug: 'wiki/example',
            confidence: 1,
            expired_at: null,
            created_at: '2026-08-16',
          }];
        }
        return [];
      },
    } as any;

    const detail = await getAdminBrainPageDetail(engine, 'duwu', 'wiki/example');
    expect(detail?.facts).toHaveLength(1);
    expect(detail?.facts[0]?.fact).toBe('挂在这个页面上的事实');
  });

  test('overview reports active facts without changing page inventory', async () => {
    const engine = {
      getStats: async () => ({
        page_count: 10,
        chunk_count: 20,
        embedded_count: 18,
        link_count: 4,
        tag_count: 1,
        timeline_entry_count: 0,
        pages_by_type: { note: 10 },
      }),
      executeRaw: async (sql: string) => {
        if (sql.includes('COUNT(*) FILTER (WHERE expired_at IS NULL)')) return [{ fact_count: 3, active_fact_count: 2 }];
        if (sql.includes('FROM pages WHERE source_id')) return [{ page_count: 10 }];
        if (sql.includes('FROM sources') && sql.includes('ORDER BY')) return [];
        if (sql.includes('FROM sources')) return [{ archived_at: null, archive_expires_at: null }];
        if (sql.includes('MAX(updated_at)')) return [{ updated_at: null }];
        if (sql.includes('FROM content_chunks')) return [{ pending: 2 }];
        return [];
      },
      getConfig: async () => null,
    } as any;
    const overview = await getAdminBrainOverview(engine, { engine: 'pglite' } as any, '1.2.44');
    expect(overview.stats.page_count).toBe(10);
    expect(overview.stats.fact_count).toBe(3);
    expect(overview.stats.active_fact_count).toBe(2);
  });
});
