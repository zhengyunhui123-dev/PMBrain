import { describe, expect, test } from 'bun:test';
import { normalizeChineseQuery } from '../../src/core/search/query-normalize-zh.ts';

describe('normalizeChineseQuery', () => {
  test('normalizes full-width characters and project vocabulary', () => {
    const view = normalizeChineseQuery('Ａ项目的责任人和延误风险');
    expect(view.normalized).toBe('A项目的负责人和延期风险');
    expect(view.lexicalQueries).toContain('A项目的负责人和延期风险');
    expect(view.lexicalQueries).toContain('A项目的责任人和延误风险');
  });

  test('extracts relative time into an explicit local calendar window', () => {
    const view = normalizeChineseQuery(
      '上周项目进度',
      new Date(2026, 6, 25, 12, 0, 0),
    );
    expect(view.normalized).toBe('项目进展');
    expect(view.since).toEqual(new Date(2026, 6, 13));
    expect(view.until).toEqual(new Date(2026, 6, 20));
  });

  test('leaves non-Chinese queries as a single normalized variant', () => {
    expect(normalizeChineseQuery('  Project   status  ')).toEqual({
      normalized: 'Project status',
      lexicalQueries: ['Project status'],
    });
  });

  test.each([
    ['北辰泵站最大的隐患是什么', '北辰泵站'],
    ['北辰泵站负责人答应完成什么', '北辰泵站'],
    ['北辰泵站需求提出的日期', '北辰泵站'],
    ['北辰泵站合同金额是多少', '北辰泵站'],
    ['北辰泵站为什么换方案，最终决定是什么', '北辰泵站'],
    ['请问《东方试点二期》的负责人是谁？', '东方试点二期'],
    ['关于PMBrain发布系统的风险是什么？', 'PMBrain发布系统'],
  ])('keeps the topic in %s without needing an answer or catalog', (query, topic) => {
    const view = normalizeChineseQuery(query);
    expect(view.lexicalQueries).toContain(topic);
    expect(view.lexicalQueries.length).toBeLessThanOrEqual(4);
    expect(view.lexicalQueries).not.toContain('风险');
  });

  test('retains the original phrase and calendar filters when extracting a topic', () => {
    const view = normalizeChineseQuery('上周北辰泵站的进度怎么样', new Date(2026, 9, 17, 12));
    expect(view.lexicalQueries).toContain('北辰泵站的进度怎么样');
    expect(view.lexicalQueries).toContain('北辰泵站');
    expect(view.since).toEqual(new Date(2026, 9, 5));
    expect(view.until).toEqual(new Date(2026, 9, 12));
  });

  test.each(['风险', '合同金额', '北辰泵站', '谁负责', '最大的隐患是什么', '为什么换方案'])('does not invent a topic for %s', (query) => {
    const view = normalizeChineseQuery(query);
    expect(view.lexicalQueries.every(value => value.length >= 2)).toBe(true);
    expect(view.lexicalQueries).not.toContain('项目');
  });
});
