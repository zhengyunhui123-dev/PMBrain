import { expect, test } from 'bun:test';
import { mixRoundWork } from '../src/core/pmbrain-adapters/deep-round-work';
import { deepContentBudgetMs, type DeepStageResult } from '../shared/deep-organize-progress';

test('先做新资料，给积压保留十份，空余额度可以互补', () => {
  const fresh = Array.from({ length: 65 }, (_, index) => `new-${index}`);
  const older = Array.from({ length: 60 }, (_, index) => `old-${index}`);
  const selected = mixRoundWork(fresh, older, 50);
  expect(selected).toHaveLength(50);
  expect(selected.slice(0, 5)).toEqual([...fresh.slice(0, 4), older[0]]);
  expect(selected.filter(value => value.startsWith('old-'))).toEqual(older.slice(0, 10));
  expect(mixRoundWork([], older, 50)).toEqual(older.slice(0, 50));
  expect(mixRoundWork(fresh, older.slice(0, 2), 50).filter(value => value.startsWith('new-'))).toHaveLength(48);
});

test('阶段用时共享三十分钟，前一阶段剩余时间可给后一阶段', () => {
  const relations: DeepStageResult = { id: 'relations', durationMs: 2 * 60_000, status: 'completed', result: '', detail: '' };
  expect(deepContentBudgetMs('relations', [])).toBe(5 * 60_000);
  expect(deepContentBudgetMs('knowledge', [relations])).toBe(18 * 60_000);
  expect(deepContentBudgetMs('knowledge', [{ ...relations, durationMs: 22 * 60_000 }])).toBe(0);
  expect(deepContentBudgetMs('sync', [])).toBeUndefined();
});
