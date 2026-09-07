import { expect, test } from 'bun:test';
import { isJunkFact } from '../src/core/facts/extract.ts';

test('assistant narration and provider errors are filtered without discarding commitments', () => {
  expect(isJunkFact('Let me inspect the repository')).toBe(true);
  expect(isJunkFact('Rate limit exceeded')).toBe(true);
  expect(isJunkFact('I will deliver the project tomorrow', 'commitment')).toBe(false);
  expect(isJunkFact('Alice wants a monthly spend limit of $200')).toBe(false);
  expect(isJunkFact('我会在周五交付项目方案', 'commitment')).toBe(false);
  expect(isJunkFact('项目接口限制为每分钟一千次请求')).toBe(false);
  expect(isJunkFact('用户希望把预算上限设为两千元')).toBe(false);
});
