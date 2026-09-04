/**
 * 产品经理可读的测试说明：
 * 首页点按钮不能去执行 pmbrain advisor --apply。
 * 继续处理要走现有补向量任务，而且不能再卡 30 分钟就停；立即同步要走指定知识源同步，孤立知识只能进入只读查看页。
 * 升级数据库不能在正在运行的服务上硬跑迁移。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAdminAdvisorAction } from '../src/core/advisor/product.ts';
import type { AdvisorProductSuggestion } from '../src/core/advisor/product.ts';

function suggestion(over: Partial<AdvisorProductSuggestion>): AdvisorProductSuggestion {
  return {
    id: 'x',
    severity: 'info',
    title: 't',
    action_label: null,
    action_kind: 'none',
    ...over,
  };
}

describe('Admin advisor actions reuse existing jobs', () => {
  test('homepage continue-processing uses unbounded embed catch-up', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/commands/admin-advisor.ts'), 'utf8');
    expect(source).toContain("startActionRun('embed_stale', cwd, hooks, { embedCatchUp: true })");
  });

  test('maps homepage buttons onto existing Admin tasks', () => {
    expect(resolveAdminAdvisorAction(suggestion({
      id: 'low_embed_coverage',
      dispatch_id: 'embed_stale',
      action_kind: 'embed_stale',
      action_label: '继续处理',
    }))).toEqual({ kind: 'embed_stale' });

    expect(resolveAdminAdvisorAction(suggestion({
      id: 'stale_sync:work',
      dispatch_id: 'sync_source:work',
      action_kind: 'sync_source',
      source_id: 'work',
      action_label: '立即同步',
    }))).toEqual({ kind: 'sync_source', sourceId: 'work' });

    expect(resolveAdminAdvisorAction(suggestion({
      id: 'orphan_pages',
      action_kind: 'navigate',
      action_label: '查看孤立知识',
      navigate: 'graph?view=isolated',
    }))).toEqual({ kind: 'navigate', page: 'graph?view=isolated' });
  });

  test('refuses to apply migrations against a live Admin/sidecar process', () => {
    expect(resolveAdminAdvisorAction(suggestion({
      id: 'pending_migration',
      dispatch_id: 'apply_migrations',
      action_kind: 'restart_required',
      action_label: '重启应用',
    }))).toEqual({ kind: 'restart_required' });
  });
});
