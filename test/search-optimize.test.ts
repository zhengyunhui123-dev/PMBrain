import { expect, test } from 'bun:test';
import {
  addCapturedSearchOptimize,
  addSearchOptimize,
  emptySearchOptimize,
  finishSearchOptimize,
  readSearchOptimize,
  searchOptimizeKey,
} from '../src/product/tasks/search-optimize.ts';

test('同一份资料只记一次，仅关键词不进入待优化', () => {
  const empty = emptySearchOptimize();
  expect(addSearchOptimize(empty, 'library', ['notes/a', 'notes/a', 'bad:slug'], false)).toBe(empty);
  const added = addSearchOptimize(empty, 'library', ['notes/a', 'notes/a', 'bad:slug'], true);
  expect(added.items).toEqual([{ sourceId: 'library', slug: 'notes/a' }]);
  expect(added.authorized).toEqual([searchOptimizeKey('library', 'notes/a')]);
  expect(added.done).toBe(0);
  expect(addSearchOptimize(added, 'library', ['notes/a'], true)).toBe(added);
});

test('暂停后新资料只排队，不解除暂停', () => {
  const paused = { ...emptySearchOptimize(), paused: true, done: 2, items: [{ sourceId: 'library', slug: 'notes/a' }] };
  const next = addSearchOptimize(paused, 'library', ['notes/b'], true);
  expect(next.paused).toBe(true);
  expect(next.done).toBe(2);
  expect(next.items.map(item => item.slug)).toEqual(['notes/a', 'notes/b']);
});

test('完成一页只减少待处理，本轮清空后计数留给已完成卡片', () => {
  const started = addSearchOptimize(emptySearchOptimize(), 'library', ['notes/a', 'notes/b'], true);
  const once = finishSearchOptimize(started, 'library', 'notes/a');
  expect(once.done).toBe(1);
  expect(once.items.map(item => item.slug)).toEqual(['notes/b']);
  const done = finishSearchOptimize(once, 'library', 'notes/b');
  expect(done.done).toBe(2);
  expect(done.items).toEqual([]);
  expect(finishSearchOptimize(done, 'library', 'notes/b')).toBe(done);
  const again = addSearchOptimize(done, 'library', ['notes/c'], true);
  expect(again.done).toBe(0);
  expect(again.items).toEqual([{ sourceId: 'library', slug: 'notes/c' }]);
});

test('未授权或混合来源的整理结果不进入待优化', () => {
  const authorized = addSearchOptimize(emptySearchOptimize(), 'library', ['notes/a'], true);
  expect(addCapturedSearchOptimize(authorized, 'library', ['people/liu'], [])).toBe(authorized);
  expect(addCapturedSearchOptimize(authorized, 'library', ['people/liu'], ['notes/missing'])).toBe(authorized);
  expect(addCapturedSearchOptimize(authorized, 'library', ['people/liu'], ['notes/a', 'notes/missing'])).toBe(authorized);
  const captured = addCapturedSearchOptimize(authorized, 'library', ['people/liu', 'people/liu'], ['notes/a']);
  expect(captured.items.map(item => item.slug)).toEqual(['notes/a', 'people/liu']);
  expect(captured.authorized).toContain(searchOptimizeKey('library', 'people/liu'));
});

test('损坏的进度读成空集合，带冒号的路径被忽略', () => {
  expect(readSearchOptimize('not-json')).toEqual(emptySearchOptimize());
  expect(readSearchOptimize(null).items).toEqual([]);
  const raw = JSON.stringify({
    paused: true,
    done: 3,
    items: [{ sourceId: 'library', slug: 'notes/a' }, { sourceId: 'library', slug: 'source:notes/a' }, { sourceId: 'library', slug: 'notes/a' }],
    authorized: ['library\nnotes/a', 'bad'],
  });
  expect(readSearchOptimize(raw)).toEqual({
    paused: true,
    done: 3,
    items: [{ sourceId: 'library', slug: 'notes/a' }],
    authorized: ['library\nnotes/a'],
  });
});
