import { expect, test } from 'bun:test';
import { locateQuote } from '../src/core/cycle/extract-atoms.ts';

test('Chinese quotations preserve original offsets and do not verify a negated paraphrase', () => {
  const text = '会议结论：我们不会取消项目。下一步：继续交付 🚀';
  const quote = '我们不会取消项目。';
  const location = locateQuote(text, quote)!;
  expect(text.slice(location.start, location.end)).toBe(quote);
  expect(locateQuote(text, '我们会取消项目。')).toBeNull();
  const emoji = locateQuote(text, '继续交付 🚀')!;
  expect(text.slice(emoji.start, emoji.end)).toBe('继续交付 🚀');
  expect(locateQuote('继续交付。继续交付。', '继续交付。')).toBeNull();
});
