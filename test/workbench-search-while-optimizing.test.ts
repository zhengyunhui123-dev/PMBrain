import { expect, test } from 'bun:test';
import { backgroundVectorizingBlocksSemantic, workbenchSearchDuringTasks } from '../src/product/workbench/routes';

const hit = { mode: 'keyword' as const, query: '导入', limit: 6, vector_enabled: false, result_count: 0, results: [] };

test('后台优化搜索进行时，对话检索改走关键词', async () => {
  const modes: unknown[] = [];
  const search = workbenchSearchDuringTasks(
    { cachedRuns: () => [{ searchOptimize: true, status: 'running' }] },
    async (_engine, input) => { modes.push(input.mode); return { ...hit, query: String(input.query) }; },
  );
  await search({} as never, { query: '导入过程能搜索吗', mode: 'semantic', limit: 6 });
  expect(modes).toEqual(['keyword']);
  expect(backgroundVectorizingBlocksSemantic([{ searchOptimize: true, status: 'queued' }])).toBe(true);
  expect(backgroundVectorizingBlocksSemantic([{ searchOptimize: true, status: 'paused' }])).toBe(false);
  expect(backgroundVectorizingBlocksSemantic([{ searchOptimize: true, status: 'completed' }])).toBe(false);
});

test('没有正在进行的优化搜索时，对话仍按语义检索', async () => {
  const modes: unknown[] = [];
  const search = workbenchSearchDuringTasks(
    { cachedRuns: () => [{ searchOptimize: true, status: 'completed' }] },
    async (_engine, input) => { modes.push(input.mode); return { ...hit, mode: 'semantic', query: String(input.query) }; },
  );
  await search({} as never, { query: '导入过程能搜索吗', mode: 'semantic', limit: 6 });
  expect(modes).toEqual(['semantic']);
});
