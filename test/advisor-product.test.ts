/**
 * 产品经理可读的测试说明：
 * 首页健康卡片要把底层检查翻译成普通人能看懂的中文，并接到已有任务：
 * 未向量化 → 继续处理；知识源过期 → 立即同步；孤立知识 → 整理关系。
 * 未配置向量时不能再推荐 ZeroEntropy，也不能假装可以一键补向量。
 */
import { describe, expect, test } from 'bun:test';
import { buildAdvisorProductView, resolveAdminAdvisorAction } from '../src/core/advisor/product.ts';
import type { AdvisorFinding, AdvisorReport } from '../src/core/advisor/types.ts';

function finding(over: Partial<AdvisorFinding>): AdvisorFinding {
  return {
    id: 'x',
    severity: 'info',
    title: 't',
    fix: { command_argv: null },
    collector: 'c',
    ask_user: true,
    ...over,
  };
}

function report(findings: AdvisorFinding[], worst: AdvisorReport['worst'] = 'warn'): AdvisorReport {
  return { version: '1.3.11', generated_at: '2026-08-29T00:00:00.000Z', findings, worst };
}

describe('advisor product view', () => {
  test('maps score bands and the three homepage actions into Chinese copy', () => {
    const view = buildAdvisorProductView(report([
      finding({
        id: 'low_embed_coverage',
        severity: 'warn',
        title: '168 chunks are missing embeddings.',
        fix: { command_argv: ['pmbrain', 'embed', '--stale'], dispatch_id: 'embed_stale' },
        collector: 'usage-shape',
      }),
      finding({
        id: 'stale_sync:work',
        severity: 'info',
        title: 'Source "work" has not synced in 5 days.',
        fix: { command_argv: ['pmbrain', 'sync', '--source', 'work'], dispatch_id: 'sync_source:work' },
        collector: 'stalled-jobs',
      }),
      finding({
        id: 'orphan_pages',
        severity: 'info',
        title: '326 knowledge pages have no links in or out.',
        fix: { command_argv: ['pmbrain', 'dream', '--phase', 'orphans'], dispatch_id: 'organize_orphans' },
        collector: 'usage-shape',
      }),
    ]), 92);

    expect(view.status).toBe('good');
    expect(view.status_label).toBe('良好');
    expect(view.score).toBe(92);
    expect(view.suggestion_count).toBe(3);
    expect(view.suggestions.map((item) => item.title)).toEqual([
      '168 个 Chunk 尚未向量化',
      '知识源 work 已 5 天未同步',
      '发现 326 个孤立知识',
    ]);
    expect(view.suggestions.map((item) => item.action_label)).toEqual([
      '继续处理',
      '立即同步',
      '整理关系',
    ]);
    expect(resolveAdminAdvisorAction(view.suggestions[0]!)).toEqual({ kind: 'embed_stale' });
    expect(resolveAdminAdvisorAction(view.suggestions[1]!)).toEqual({ kind: 'sync_source', sourceId: 'work' });
    expect(resolveAdminAdvisorAction(view.suggestions[2]!)).toEqual({ kind: 'dream_orphans' });
  });

  test('does not offer embed-now when vectors are not configured, and never mentions ZeroEntropy', () => {
    const view = buildAdvisorProductView(report([
      finding({
        id: 'embedding_not_configured',
        severity: 'warn',
        title: 'No embedding model is configured.',
        detail: 'Set embedding_model and embedding_dimensions first.',
        collector: 'setup-smells',
      }),
    ]), 70);
    expect(view.status_label).toBe('一般');
    expect(view.suggestions[0]?.title).toContain('向量');
    expect(JSON.stringify(view)).not.toMatch(/zeroentropy/i);
    expect(resolveAdminAdvisorAction(view.suggestions[0]!)).toEqual({
      kind: 'navigate',
      page: 'config',
    });
  });

  test('pending migrations ask the desktop user to restart instead of writing the live database', () => {
    const view = buildAdvisorProductView(report([
      finding({
        id: 'pending_migration',
        severity: 'critical',
        title: 'Schema migrations are pending.',
        fix: { command_argv: ['pmbrain', 'apply-migrations', '--yes'], dispatch_id: 'apply_migrations' },
        collector: 'migration',
      }),
    ], 'critical'), 40);
    expect(view.status_label).toBe('需要处理');
    expect(resolveAdminAdvisorAction(view.suggestions[0]!)).toEqual({ kind: 'restart_required' });
  });
});
