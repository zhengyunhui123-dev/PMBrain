/**
 * 产品经理能看懂的测试说明：
 * 深度整理写完页之后，检索和链接要认得出同一件事。
 * 这里不连数据库。它确认公司简称怎么并回原页、跨资料的相同知识点怎么算同一标题、
 * 概念近义标签怎么收成已有页、写坏的 [[链接]] 怎么被看出来、
 * 原子页和综合页会不会进入搜索加权，以及实体队列在没有允许名单时仍整批领取、
 * 给了允许名单后只领取本轮页面或本任务自己登记的页面。
 */
import { expect, test } from 'bun:test';
import matter from 'gray-matter';
import { atomTitleKey } from '../src/core/cycle/atom-identity.ts';
import { danglingWikilinks, wikilinkTargets } from '../src/core/cycle/dream-link-audit.ts';
import { rewriteCapturedIdentity } from '../src/core/cycle/entity-capture-budget.ts';
import { syncPhasePages, type PhaseResult } from '../src/core/cycle.ts';
import { DEFAULT_SOURCE_BOOSTS } from '../src/core/search/source-boost.ts';
import { collapseConceptLabels } from '../src/core/cycle/synthesize-concepts.ts';
import { selectCaptureClaim } from '../src/product/tasks/maintenance-orchestration.ts';

test('同一知识点去掉空白后标题相同，检索和合并认的是这一份', () => {
  expect(atomTitleKey('成本控制 ')).toBe(atomTitleKey('成本控制'));
  expect(atomTitleKey('成本\u00a0控制')).toBe('成本 控制');
});

test('概念只在已有短名唯一对应时收成那一页，泛词和多家近义不合并', () => {
  expect(collapseConceptLabels(['成本控制流程'], ['成本控制']).get('成本控制流程')).toBe('成本控制');
  expect(collapseConceptLabels(['成本控制 '], []).get('成本控制 ')).toBe('成本控制');
  const ambiguous = collapseConceptLabels(['成本控制流程', '成本控制方法'], ['成本控制']);
  expect(ambiguous.get('成本控制流程')).toBe('成本控制流程');
  expect(ambiguous.get('成本控制方法')).toBe('成本控制方法');
  expect(collapseConceptLabels(['系统流程'], ['系统']).get('系统流程')).toBe('系统流程');
  expect(collapseConceptLabels(['成本控制流程'], []).get('成本控制流程')).toBe('成本控制流程');
});

test('综合页里点不开的双链会被标出，代码块和网址不算', () => {
  const body = '见 [[companies/caixun]] 和 [[wiki/missing]]。\n```\n[[secret/hidden]]\n```\n[[https://example.com/a]]';
  expect(wikilinkTargets(body)).toEqual(['companies/caixun', 'wiki/missing']);
  expect(danglingWikilinks(body, new Set(['companies/caixun']))).toEqual(['wiki/missing']);
  expect(danglingWikilinks('[[knowledge-auto:people/liu]]', new Set(['people/liu']))).toEqual([]);
});

test('简称写回已有公司时保留原来的标题，并把简称记成别名', () => {
  const written = rewriteCapturedIdentity('---\ntitle: 彩讯\ntype: company\n---\n彩讯发布了年度报告。\n', '彩讯股份', '彩讯');
  const parsed = matter(written);
  expect(parsed.data.title).toBe('彩讯股份');
  expect(parsed.data.aliases).toEqual(['彩讯']);
  expect(parsed.content).toContain('彩讯发布了年度报告');
});

test('原子页、项目页和综合页会提高搜索权重，摘录页仍然压低', () => {
  expect(DEFAULT_SOURCE_BOOSTS['atoms/']).toBe(1.2);
  expect(DEFAULT_SOURCE_BOOSTS['projects/']).toBe(1.2);
  expect(DEFAULT_SOURCE_BOOSTS['wiki/originals/']).toBe(1.35);
  expect(DEFAULT_SOURCE_BOOSTS['wiki/personal/patterns/']).toBe(1.35);
  expect(DEFAULT_SOURCE_BOOSTS['concepts/']).toBe(1.3);
  expect(DEFAULT_SOURCE_BOOSTS['extracts/']).toBe(0.3);
});

test('同步写过的页面名单能从阶段结果里读出来，失败阶段没有名单', () => {
  const listed = syncPhasePages({
    phase: 'sync', status: 'ok', duration_ms: 0, summary: '', details: {}, pagesAffected: ['notes/a'],
  } as PhaseResult & { pagesAffected?: string[] });
  expect(listed).toEqual(['notes/a']);
  expect(syncPhasePages({
    phase: 'sync', status: 'ok', duration_ms: 0, summary: '', details: { pages_affected: ['notes/b', 1] },
  })).toEqual(['notes/b']);
  expect(syncPhasePages({
    phase: 'sync', status: 'fail', duration_ms: 0, summary: '', details: {},
  })).toBeUndefined();
  expect(syncPhasePages({
    phase: 'extract', status: 'ok', duration_ms: 0, summary: '', details: { pages_affected: ['notes/c'] },
  })).toBeUndefined();
});

test('实体队列没给范围时整批领取；给了本轮范围时，别的任务留下的旧页继续排队', () => {
  const owners = { first: 7, old: 3, mine: 9 };
  expect(selectCaptureClaim(['first', 'old', 'mine'], undefined, owners, 9)).toEqual(['first', 'old', 'mine']);
  expect(selectCaptureClaim(['first', 'old', 'mine'], [], owners, 9)).toEqual(['mine']);
  expect(selectCaptureClaim(['first', 'old', 'mine'], ['first'], owners, 9)).toEqual(['first', 'mine']);
});
