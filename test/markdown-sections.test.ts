import { describe, expect, test } from 'bun:test';
import { buildMarkdownParentSections } from '../src/core/document/markdown-sections.ts';

describe('Markdown heading sections for oversized local files', () => {
  test('splits a technical spec into heading sections so later import can slice each chapter', () => {
    const sections = buildMarkdownParentSections([
      '前言一段。',
      '',
      '# 硬件规格',
      '',
      '主机箱尺寸和供电要求。',
      '',
      '## 接口定义',
      '',
      '网口、串口和调试口说明。',
    ].join('\n'), 'HSM 规格');

    expect(sections.map(section => section.title)).toEqual(['HSM 规格', '硬件规格', '接口定义']);
    expect(sections[0]?.text).toContain('前言一段');
    expect(sections[1]?.locator).toBe('章节：硬件规格');
    expect(sections[2]?.text).toContain('网口、串口');
  });

  test('a file without headings stays one section so it can still be chunked', () => {
    const sections = buildMarkdownParentSections('这是一整篇没有小标题的说明。'.repeat(3), '整篇说明');
    expect(sections).toEqual([{
      title: '整篇说明',
      locator: '文档开头',
      text: '这是一整篇没有小标题的说明。'.repeat(3),
    }]);
  });
});
