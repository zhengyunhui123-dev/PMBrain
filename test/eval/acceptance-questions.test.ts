/**
 * 产品经理可以这样理解这次测试：
 * 验收题要先固定下来，以后用同一组问题看搜索和整理有没有变好。
 * 这轮只检查题集本身齐不齐，以及其中能确定判断的规则，例如“最近一次”不是 30 天。
 * 不连接正式知识库，也不编写一套看起来像已经跑完的分数。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeChineseQuery } from '../../src/core/search/query-normalize-zh.ts';

const questions = readFileSync(new URL('../../docs/eval/2026-11-14-当前版本验收题集.md', import.meta.url), 'utf8');

describe('当前版本验收题集', () => {
  test('固定 40 道题，覆盖六类验收，而且没有写成跑分报告', () => {
    const numbered = questions.split(/\r?\n/).filter(line => /^\d+\. /.test(line));
    expect(numbered).toHaveLength(40);
    expect(new Set(numbered.map(line => line.slice(0, line.indexOf('.')))).size).toBe(40);
    for (const heading of ['新导入后能否找到', '更正之后旧结论怎么标', '换一种说法', '两个知识源同名', '深度整理之后', '外部 AI 引用原文']) {
      expect(questions).toContain(heading);
    }
    expect(questions).toContain('我昨天更正了一份项目资料，今天外部 AI 能否找到新内容、识别旧结论，并准确引用原文完成工作？');
    expect(questions).toContain('不是 1.6.x 的模型跑分报告');
    expect(questions).not.toMatch(/Recall@\d+\s*[:：]\s*\d/);
    expect(questions).not.toMatch(/通过率\s*[:：]\s*\d/);
  });

  test('题集里的时间问法按检索规则解释，不调用模型', () => {
    const now = new Date(2026, 10, 14, 12, 0, 0);
    const latest = normalizeChineseQuery('项目最近一次验收的结论是什么', now);
    expect(latest.since).toBeUndefined();
    expect(latest.until).toBeUndefined();
    expect(latest.normalized).toContain('验收');
    const windowed = normalizeChineseQuery('最近30天的会议', now);
    expect(windowed.since).toEqual(new Date(2026, 9, 16));
    expect(windowed.until).toEqual(new Date(2026, 10, 15));
  });
});
