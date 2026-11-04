import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine';
import type { Page } from '../src/core/types';
import { DeepOutputReceipt } from '../src/product/tasks/deep-output-receipt';
import { loadAllowedSlugPrefixes } from '../src/core/cycle/allowed-slug-prefixes';

function fixture() {
  let pages = new Map<string, Page>();
  const build = (): BrainEngine => ({
    getPage: async (slug: string, opts?: { sourceId?: string }) => pages.get(`${opts?.sourceId ?? 'default'}:${slug}`) ?? null,
    putPage: async (slug: string, input: Partial<Page>, opts?: { sourceId?: string }) => {
      const page = { ...input, slug } as Page;
      pages.set(`${opts?.sourceId ?? 'default'}:${slug}`, page);
      return page;
    },
    transaction: async (fn: (engine: BrainEngine) => Promise<unknown>) => {
      const before = new Map(pages);
      try { return await fn(build()); } catch (error) { pages = before; throw error; }
    },
  }) as unknown as BrainEngine;
  return build();
}

test('只累计真正保存的知识成果，去重同页写入并区分来源，回滚不计数', async () => {
  const receipt = new DeepOutputReceipt();
  const engine = receipt.observe(fixture());
  await engine.putPage('concepts/a', { type: 'concept', title: '概念', compiled_truth: '原文' });
  await engine.putPage('concepts/a', { type: 'concept', title: '概念', compiled_truth: '补充' });
  await engine.putPage('concepts/a', { type: 'concept', title: '概念', compiled_truth: '补充' }, { sourceId: 'other' });
  await engine.putPage('dream-cycle-summaries/today', { type: 'note', title: '运行摘要', compiled_truth: '摘要' });
  await expect(engine.transaction(async tx => {
    await tx.putPage('atoms/rollback', { type: 'atom', title: '回滚', compiled_truth: '回滚' });
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(receipt.take()).toMatchObject({ knowledge_created: 1, knowledge_maintained: 0 });
  await engine.putPage('concepts/a', { type: 'concept', title: '概念', compiled_truth: '补充' });
  expect(receipt.take()).toMatchObject({ knowledge_created: 0, knowledge_maintained: 0 });
  await engine.transaction(async tx => {
    await tx.putPage('concepts/a', { type: 'concept', title: '概念', compiled_truth: '再次补充' });
  });
  expect(receipt.take()).toMatchObject({ knowledge_created: 0, knowledge_maintained: 1 });
});

test('综合页和模式按现有归档路径统计，原始对话与内部运行摘要不混入成果', async () => {
  const receipt = new DeepOutputReceipt('default', false, await loadAllowedSlugPrefixes());
  const engine = receipt.observe(fixture());
  for (const [slug, type] of [['wiki/personal/reflections/one', 'note'], ['wiki/personal/patterns/two', 'note'], ['wiki/meetings/three', 'meeting'], ['wiki/conversations/four', 'conversation'], ['wiki/originals/five', 'note'], ['conversations/raw', 'conversation'], ['sources/raw', 'source'], ['dream-cycle-summaries/today', 'note'], ['reports/drift-today', 'report']]) {
    await engine.putPage(slug!, { type: type!, title: slug!, compiled_truth: '已保存内容' });
  }
  expect(receipt.take()).toMatchObject({ knowledge_created: 5, knowledge_maintained: 0 });
});
