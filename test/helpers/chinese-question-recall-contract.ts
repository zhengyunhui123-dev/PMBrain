import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import type { hybridSearch as Search } from '../../src/core/search/hybrid.ts';

export async function seedChineseQuestionRecall(engine: BrainEngine): Promise<void> {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('zh-recall-other', '隔离测试来源') ON CONFLICT (id) DO NOTHING");
  for (const sourceId of ['default', 'zh-recall-other']) {
    const text = `北辰泵站项目记录。需求日期：2026-10-08。合同金额：${sourceId === 'default' ? '83' : '99'}万元。负责人承诺完成现场联调。最大风险：接口延期。最终决策：采用新方案。`;
    await engine.putPage('projects/beichen', { type: 'project', title: '北辰泵站', compiled_truth: text, effective_date: new Date('2026-10-08T00:00:00Z') }, { sourceId });
    await engine.upsertChunks('projects/beichen', [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }], { sourceId });
  }
  const pages = [
    ['projects/east', '东方试点二期', 'project', '东方试点二期负责人是王工。验收风险：设备未到。'],
    ['projects/release', 'PMBrain发布系统', 'project', 'PMBrain发布系统当前风险：签名待验收。PMBrain release pipeline.'],
    ['notes/pump', '北辰泵站归档', 'note', '北辰泵站已归档资料，合同金额17万元。'],
    ...Array.from({ length: 20 }, (_, index) => [`notes/noise-${index}`, `其他项目${index}`, 'note', '负责人承诺。需求提出日期。合同金额。最终决策。最大风险是接口延期。']),
  ];
  for (const [slug, title, type, text] of pages) {
    await engine.putPage(slug!, { type: type!, title: title!, compiled_truth: text!, effective_date: new Date('2025-01-01T00:00:00Z') });
    await engine.upsertChunks(slug!, [{ chunk_index: 0, chunk_text: text!, chunk_source: 'compiled_truth' }]);
  }
}

export function chineseQuestionRecallContract(getEngine: () => BrainEngine, search: typeof Search): void {
  const opts = { sourceId: 'default', mode: 'balanced', limit: 10, expansion: false, reranker: { enabled: false, topNIn: 20, topNOut: 10 } } as const;
  test.each([
    '北辰泵站最大的隐患是什么',
    '北辰泵站负责人答应完成什么',
    '北辰泵站需求提出的日期',
    '北辰泵站合同金额是多少',
    '北辰泵站为什么换方案，最终决定是什么',
  ])('recalls the project for %s without returning generic noise', async (query) => {
    let meta: HybridSearchMeta | undefined;
    const hits = await search(getEngine(), query, { ...opts, type: 'project', onMeta: value => { meta = value; } });
    expect(hits[0]?.slug).toBe('projects/beichen');
    expect(hits.every(hit => hit.source_id === 'default' && hit.slug === 'projects/beichen')).toBe(true);
    expect(meta?.vector_enabled).toBe(false);
    expect(meta?.reranker_applied).toBe(false);
  });
  test('keeps homonymous pages within the requested Source', async () => {
    const hits = await search(getEngine(), '北辰泵站合同金额是多少', { ...opts, sourceId: 'zh-recall-other' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source_id).toBe('zh-recall-other');
    expect(hits[0]?.chunk_text).toContain('99万元');
  });
  test('preserves sourceIds precedence, type, exclusion and explicit date filters', async () => {
    const engine = getEngine();
    const query = '北辰泵站最大的隐患是什么';
    const hits = await search(engine, query, { ...opts, sourceIds: ['zh-recall-other'], type: 'project' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source_id).toBe('zh-recall-other');
    expect(await search(engine, query, { ...opts, types: ['person'] })).toHaveLength(0);
    expect(await search(engine, query, { ...opts, type: 'project', exclude_slugs: ['projects/beichen'] })).toHaveLength(0);
    expect(await search(engine, query, { ...opts, type: 'project', exclude_slug_prefixes: ['projects/'] })).toHaveLength(0);
    expect(await search(engine, query, { ...opts, afterDate: '2026-10-09T00:00:00Z' })).toHaveLength(0);
    expect(await search(engine, query, { ...opts, beforeDate: '2025-01-02T00:00:00Z' })).toHaveLength(1);
  });
  test('uses unseen quoted and mixed-language names without changing their wording', async () => {
    expect((await search(getEngine(), '请问《东方试点二期》的负责人是谁？', opts))[0]?.slug).toBe('projects/east');
    expect((await search(getEngine(), '关于PMBrain发布系统的风险是什么？', opts))[0]?.slug).toBe('projects/release');
  });
  test('keyword pages and chunks filter by event date rather than import time', async () => {
    const engine = getEngine();
    for (const run of [engine.searchKeyword.bind(engine), engine.searchKeywordChunks.bind(engine)]) {
      expect(await run('北辰泵站', { sourceId: 'default', afterDate: '2026-10-09T00:00:00Z' })).toHaveLength(0);
      expect((await run('北辰泵站', { sourceId: 'default', beforeDate: '2026-10-09T00:00:00Z' })).length).toBeGreaterThan(0);
    }
  });
  test('returns no generic risk pages when the named subject is absent', async () => {
    expect(await search(getEngine(), '不存在的远航项目最大的隐患是什么', opts)).toHaveLength(0);
  });
  test('retains exact Chinese and English keyword recall', async () => {
    expect((await search(getEngine(), '北辰泵站', { ...opts, type: 'project' }))[0]?.slug).toBe('projects/beichen');
    expect((await search(getEngine(), 'PMBrain', opts))[0]?.slug).toBe('projects/release');
  });
}
