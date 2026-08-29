/**
 * 产品经理可读的测试说明：
 * --apply 只能跑白名单里的修复，而且必须是结构化参数，不能走 shell。
 * 迁移、补向量、同步某个知识源、整理孤立页可以一键修；随便一条命令或带特殊字符的参数必须被拒绝。
 */
import { describe, expect, test } from 'bun:test';
import { resolveApplyTarget } from '../src/core/advisor/apply.ts';
import type { AdvisorFinding, AdvisorReport } from '../src/core/advisor/types.ts';

function report(findings: AdvisorFinding[]): AdvisorReport {
  return { version: '1.3.11', generated_at: 'x', findings, worst: 'info' };
}

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

describe('resolveApplyTarget', () => {
  test('allows migration, embed, source sync, and orphan organize', () => {
    const r = report([
      finding({
        id: 'pending_migration',
        fix: { command_argv: ['pmbrain', 'apply-migrations', '--yes'], dispatch_id: 'apply_migrations' },
      }),
      finding({
        id: 'low_embed_coverage',
        fix: { command_argv: ['pmbrain', 'embed', '--stale'], dispatch_id: 'embed_stale' },
      }),
      finding({
        id: 'stale_sync:work',
        fix: { command_argv: ['pmbrain', 'sync', '--source', 'work'], dispatch_id: 'sync_source:work' },
      }),
      finding({
        id: 'orphan_pages',
        fix: { command_argv: ['pmbrain', 'dream', '--phase', 'orphans'], dispatch_id: 'organize_orphans' },
      }),
    ]);
    expect(resolveApplyTarget(r, 'apply_migrations').ok).toBe(true);
    expect(resolveApplyTarget(r, 'embed_stale').ok).toBe(true);
    expect(resolveApplyTarget(r, 'sync_source:work').ok).toBe(true);
    expect(resolveApplyTarget(r, 'organize_orphans').ok).toBe(true);
  });

  test('rejects unknown ids, missing dispatch_id, non-pmbrain binaries, and shell characters', () => {
    const r = report([
      finding({
        id: 'pending_migration',
        fix: { command_argv: ['pmbrain', 'apply-migrations', '--yes'], dispatch_id: 'apply_migrations' },
      }),
      finding({ id: 'version_drift', fix: { command_argv: ['pmbrain', 'upgrade'] } }),
      finding({
        id: 'evil',
        fix: { command_argv: ['pmbrain', 'sync', '--source', 'foo; rm -rf /'], dispatch_id: 'sync_source:foo' },
      }),
    ]);
    const unknown = resolveApplyTarget(r, 'nope');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.runnable).toEqual(['apply_migrations']);
    expect(resolveApplyTarget(r, 'version_drift').ok).toBe(false);
    expect(resolveApplyTarget(r, 'sync_source:foo').ok).toBe(false);

    const foreignBinary = report([
      finding({
        id: 'rm',
        fix: { command_argv: ['rm', '-rf', '/'], dispatch_id: 'apply_migrations' },
      }),
    ]);
    expect(resolveApplyTarget(foreignBinary, 'apply_migrations').ok).toBe(false);
  });
});
