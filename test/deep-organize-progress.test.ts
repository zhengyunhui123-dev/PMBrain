import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { DeepOrganizeProgress } from '../admin/src/product/DeepOrganizeProgress';
import { TaskProductProgressSchema } from '../shared/contracts/common';
import { DEEP_ORGANIZE_STAGES, deepOrganizePercent, deepOrganizeTotals, isStagedDeepOrganize, summarizeDeepStage, type DeepRoundProgress } from '../shared/deep-organize-progress';

const adminRequire = createRequire(new URL('../admin/package.json', import.meta.url));
const { createElement } = adminRequire('react');
const { renderToStaticMarkup } = adminRequire('react-dom/server');

test('深度整理按检查、同步、理解内容、新增实体的顺序组织，试运行和单阶段仍走原流程', () => {
  const ids = DEEP_ORGANIZE_STAGES.map(stage => stage.id);
  expect(ids).toEqual(['check', 'sync', 'relations', 'knowledge', 'entities', 'concepts', 'index', 'review']);
  expect(ids.indexOf('check')).toBeLessThan(ids.indexOf('sync'));
  expect(ids.indexOf('sync')).toBeLessThan(ids.indexOf('relations'));
  expect(ids.indexOf('relations')).toBeLessThan(ids.indexOf('entities'));
  expect(DEEP_ORGANIZE_STAGES.find(stage => stage.id === 'relations')?.phases).toContain('synthesize');
  expect(DEEP_ORGANIZE_STAGES.find(stage => stage.id === 'entities')?.phases).toEqual(['capture_entities']);
  expect(isStagedDeepOrganize({ preset: 'full' })).toBe(true);
  expect(isStagedDeepOrganize({ preset: 'full', phase: 'all' })).toBe(true);
  expect(isStagedDeepOrganize({ preset: 'full', dryRun: true })).toBe(false);
  expect(isStagedDeepOrganize({ preset: 'full', phase: 'orphans' })).toBe(false);
  expect(isStagedDeepOrganize({ preset: 'quick' })).toBe(false);
});

test('同步和实体阶段用真实回执汇总，未完成的阶段不计入整体进度', () => {
  const sync = summarizeDeepStage('sync', [{ phase: 'sync', status: 'ok', duration_ms: 1200, details: { added: 6, modified: 12, failedFiles: 0 } }], { scanned: 48, unchanged: 30, incremental: 18, total: 48, complete: true });
  expect(sync.result).toBe('同步 18，新增 6，更新 12');
  expect(sync.detail).toBe('扫描 48，未变化 30，失败 0');
  expect(sync.imported).toBe(18);
  const entities = summarizeDeepStage('entities', [{ phase: 'capture_entities', status: 'ok', duration_ms: 10, details: { entities_written: 4, relations_created: 9, pages_submitted: 4 } }]);
  expect(entities.result).toBe('写入 4 个实体，新增 9 条关联');
  expect(entities.entities).toBe(4);
  expect(entities.links).toBe(9);
  const none = summarizeDeepStage('entities', [{ phase: 'capture_entities', status: 'ok', details: { pages_submitted: 0, entities_written: 0 } }]);
  expect(none.result).toBe('没有新增待识别资料，已有成果继续复用');
  const modelSkipped = summarizeDeepStage('relations', [
    { phase: 'synthesize', status: 'skipped', details: { reason: 'not_configured' } },
    { phase: 'extract', status: 'ok', details: { linksCreated: 3 } },
  ]);
  expect(modelSkipped.result).toBe('未配置本阶段所需的原始对话输入');
  expect(modelSkipped.links).toBe(3);
  const round: DeepRoundProgress = {
    stage: 'relations',
    scan: { scanned: 48, unchanged: 30, complete: true },
    stages: [{ ...sync, status: 'completed' }, { id: 'check', status: 'skipped', durationMs: 0, result: '跳过', detail: '跳过' }],
  };
  expect(deepOrganizePercent(round)).toBe(25);
  expect(deepOrganizePercent({ ...round, stage: 'done', stages: DEEP_ORGANIZE_STAGES.map(stage => ({ id: stage.id, status: stage.id === 'entities' ? 'partial' as const : 'completed' as const, durationMs: 0, result: '', detail: '' })) })).toBe(99);
  expect(deepOrganizeTotals({ ...round, stages: [sync, entities] })).toEqual({ files: 18, knowledge: 0, entities: 4, links: 9 });
});

test('深度整理详情按八个阶段展示同步、知识点和新增实体', () => {
  const round: DeepRoundProgress = {
    stage: 'entities',
    scan: { scanned: 4, unchanged: 1, incremental: 3, total: 4, complete: true },
    current: { result: '正在识别实体', file: 'notes/first.md', startedAt: '2026-11-03T00:00:00.000Z' },
    stages: [
      summarizeDeepStage('sync', [{ phase: 'sync', status: 'ok', duration_ms: 1000, details: { added: 2, modified: 1, failedFiles: 0 } }], { scanned: 4, unchanged: 1, incremental: 3, total: 4, complete: true }),
      summarizeDeepStage('knowledge', [{ phase: 'extract_atoms', status: 'ok', duration_ms: 1000, details: { atoms_extracted: 5, pages_processed: 2 } }]),
    ],
  };
  const product = { deep: round, name: 'AI 深度整理', stage: '识别和更新实体', percent: 25, phasePercent: null, completedSteps: 2, steps: [], processed: null, total: null, file: 'notes/first.md', metrics: [], errorReason: null, budget: { capCny: 5, spentCny: 0.2, reservedCny: 0, usdToCny: 7, calls: 1 } };
  expect(TaskProductProgressSchema.parse(product).deep?.stages.find(stage => stage.id === 'sync')?.result).toBe('同步 3，新增 2，更新 1');
  const html = renderToStaticMarkup(createElement(DeepOrganizeProgress, {
    link: false,
    run: {
      id: 'task-1', kind: 'dream_full', status: 'running', command: [], stdout: '', stderr: '', exitCode: null, error: null,
      startedAt: '2026-11-03T00:00:00.000Z', completedAt: null, durationMs: null,
      product,
    },
  })) as string;
  expect(html).toContain('检查知识库');
  expect(html).toContain('识别和更新实体');
  expect(html).toContain('同步 3，新增 2，更新 1');
  expect(html).toContain('提炼 5 条知识点');
  expect(html).toContain('notes/first.md');
  expect(html).toContain('¥0.20');
  expect(html).toContain('¥5.00');
});
