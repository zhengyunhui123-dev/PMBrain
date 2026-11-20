/**
 * 产品经理可以这样理解这次测试：
 * 问“最近 30 天”时，只留正文里真有日期、而且日期落在这 30 天里的资料。
 * 今天才导入、正文没有日期的旧资料，不能因为导入时间被算进这 30 天。
 * 不带时间窗时，这些没写日期的资料仍然要能被找到。
 * 测试用的是一块临时内存数据库，不会打开正在使用的知识库。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { contentEventDateExpr } from '../../src/core/search/content-date-sql.ts';
import { readFileSync } from 'node:fs';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages = [
    ['notes/undated', 'undated acceptance zebra', null, 'ingest'],
    ['notes/fallback', 'fallback acceptance zebra', new Date('2026-11-14T00:00:00Z'), 'fallback'],
    ['notes/old', 'old acceptance zebra', new Date('2026-08-01T00:00:00Z'), 'event_date'],
    ['notes/fresh', 'fresh acceptance zebra', new Date('2026-11-01T00:00:00Z'), 'event_date'],
  ] as const;
  for (const [slug, body, date, source] of pages) {
    await engine.putPage(slug, {
      title: slug,
      type: 'note',
      compiled_truth: body,
      timeline: '',
      frontmatter: {},
      effective_date: date,
      effective_date_source: source,
    });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }]);
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('content date windows', () => {
  test('a 30 day window keeps the dated page and leaves out import time', async () => {
    const rows = await engine.searchKeyword('acceptance zebra', {
      limit: 20,
      afterDate: '2026-10-16T00:00:00.000Z',
      beforeDate: '2026-11-15T00:00:00.000Z',
    });
    const slugs = rows.map(row => row.slug);
    expect(slugs).toContain('notes/fresh');
    expect(slugs).not.toContain('notes/undated');
    expect(slugs).not.toContain('notes/fallback');
    expect(slugs).not.toContain('notes/old');
  });

  test('without a window, a page that has no content date is still findable', async () => {
    const rows = await engine.searchKeyword('undated acceptance zebra', { limit: 20 });
    expect(rows.map(row => row.slug)).toContain('notes/undated');
  });

  test('both database engines use the content date for windows', () => {
    const fragment = contentEventDateExpr('p');
    expect(fragment).toContain("NOT IN ('fallback', 'ingest')");
    const pglite = readFileSync(new URL('../../src/core/pglite-engine.ts', import.meta.url), 'utf8');
    const postgres = readFileSync(new URL('../../src/core/postgres-engine.ts', import.meta.url), 'utf8');
    for (const source of [pglite, postgres]) {
      expect(source).toContain('contentEventDateExpr');
      expect(source).not.toContain('COALESCE(p.effective_date, p.updated_at, p.created_at) >');
      expect(source).not.toContain('COALESCE(p.effective_date, p.updated_at, p.created_at) <');
      expect(source).not.toContain('COALESCE(p.updated_at, p.created_at) >');
      expect(source).not.toContain('COALESCE(p.updated_at, p.created_at) <');
    }
  });
});
