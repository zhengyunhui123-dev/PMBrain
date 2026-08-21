/**
 * Second-batch chat adapters: accept PM/AI transcript shapes that previously
 * produced zero turns, while leaving ordinary Markdown headings untouched.
 */

import { describe, expect, test } from 'bun:test';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';

describe('second-batch conversation adapters', () => {
  test('parses Markdown heading turns used by AI transcript exports', () => {
    const body = [
      '## User',
      '请把项目风险按优先级整理。',
      '',
      '## Assistant',
      '我会先核对范围，再列出高、中、低风险。',
    ].join('\n');
    const result = parseConversation(body, { fallbackDate: '2026-08-21' });
    expect(result.matched_pattern_id).toBe('markdown-heading-turn');
    expect(result.messages.map((message) => message.speaker)).toEqual(['User', 'Assistant']);
    expect(result.messages[0].text).toContain('项目风险');
  });

  test('normalizes Slack-style header plus indented message blocks', () => {
    const body = [
      '- **云辉** (Mon 11:18)',
      '  先完成来源同步。',
      '',
      '  再进入深度整理。',
      '- **PMBrain** (Mon 11:20)',
      '  收到，会保留 Source 边界。',
    ].join('\n');
    const result = parseConversation(body, { fallbackDate: '2026-08-21' });
    expect(result.matched_pattern_id).toBe('bold-paren-time');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].text).toBe('先完成来源同步。 再进入深度整理。');
    expect(result.messages[1].speaker).toBe('PMBrain');
  });

  test('ordinary document headings do not become chat turns', () => {
    const result = parseConversation('## Summary\n普通项目总结。\n## Risks\n没有角色对话。');
    expect(result.messages).toEqual([]);
  });

  test.each([
    {
      name: 'time-only 12-hour iMessage Markdown',
      body: '**Alice** (9:15 PM): 晚上继续整理。\n**Bob** (9:16 PM): 收到。',
      pattern: 'bold-paren-time-12h',
      speakers: ['Alice', 'Bob'],
    },
    {
      name: 'Slack Markdown time plus dash',
      body: '**Alice** 09:15 — 先同步来源。\n补充说明。\n**Bob** 09:16 - 再做全局整理。',
      pattern: 'bold-time-dash',
      speakers: ['Alice', 'Bob'],
    },
    {
      name: 'Fathom Speaker A/B transcript',
      body: 'Speaker A: 先核对来源。\nSpeaker B: 再运行整理。',
      pattern: 'speaker-letter-no-time',
      speakers: ['Speaker A', 'Speaker B'],
    },
    {
      name: 'ChatGPT Markdown export with long replies',
      body: '**You:** 请整理这个项目。\n\n补充第一点。\n补充第二点。\n\n**ChatGPT:** 我会先核对来源。\n\n然后给出方案。',
      pattern: 'chatgpt-export-you-chatgpt',
      speakers: ['You', 'ChatGPT'],
    },
    {
      name: 'meeting transcript with bold names and no time',
      body: '**Alice:** 先确认范围。\n**Bob:** 范围已经确认。',
      pattern: 'bold-name-no-time',
      speakers: ['Alice', 'Bob'],
    },
  ])('parses $name', ({ body, pattern, speakers }) => {
    const result = parseConversation(body, { fallbackDate: '2026-08-21' });
    expect(result.matched_pattern_id).toBe(pattern);
    expect(result.messages.map((message) => message.speaker)).toEqual([...speakers]);
  });

  test('a ChatGPT label buried in ordinary prose is not treated as a transcript', () => {
    const prose = [
      ...Array.from({ length: 20 }, (_, index) => `普通说明第 ${index + 1} 行。`),
      '**You:** 这里只是格式示例。',
      '**ChatGPT:** 这里也是格式示例。',
      ...Array.from({ length: 20 }, (_, index) => `后续说明第 ${index + 1} 行。`),
    ].join('\n');
    expect(parseConversation(prose).messages).toEqual([]);
  });
});
