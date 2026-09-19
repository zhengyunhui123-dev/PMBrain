/**
 * 产品经理可读的测试说明：
 * 近期会议还没投影到年表时，知识库体检必须出现真实的 coverage gap；
 * 干净知识库不能编造建议；--apply 不能跑 chronicle-backfill。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import { runAdvisor } from '../src/core/advisor/run.ts';
import { resolveApplyTarget } from '../src/core/advisor/apply.ts';
import { buildAdvisorProductView } from '../src/core/advisor/product.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;
const ctx = (over: Partial<AdvisorContext> = {}): AdvisorContext => ({
  engine,
  config: { engine: 'pglite' } as AdvisorContext['config'],
  version: '1.3.65',
  workspace: null,
  skillsDir: null,
  now: new Date(),
  remote: false,
  ...over,
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw(`DELETE FROM pages WHERE type IN ('meeting','conversation','calendar-event','event')`);
});

describe('collectChronicle', () => {
  test('flags recent meetings with no timeline coverage', async () => {
    await engine.putPage('meetings/recent', { type: 'meeting', title: 'recent', compiled_truth: 'x'.repeat(120) });
    const findings = await collectChronicle.collect(ctx());
    const gap = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeTruthy();
    expect(gap!.severity).toBe('info');
    expect(gap!.fix.dispatch_id).toBeUndefined();
    expect(gap!.fix.command_argv).toEqual(['pmbrain', 'chronicle-backfill']);
    expect(gap!.ask_user).toBe(true);
  });

  test('flags unresolved ontology conflicts', async () => {
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'advisor', source: 'm/a', validFrom: '2026-05-01' });
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'founder', source: 'm/b', validFrom: '2026-01-01' });
    const findings = await collectChronicle.collect(ctx());
    const conflict = findings.find((f) => f.id === 'ontology_conflicts');
    expect(conflict).toBeTruthy();
    expect(conflict!.severity).toBe('warn');
    expect(conflict!.fix.dispatch_id).toBeUndefined();
  });

  test('no findings on a clean brain', async () => {
    const findings = await collectChronicle.collect(ctx());
    expect(findings).toHaveLength(0);
  });

  test('projected meetings do not invent a coverage gap', async () => {
    const page = await engine.putPage('meetings/projected', { type: 'meeting', title: 'projected', compiled_truth: 'x'.repeat(120) });
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, event_page_id)
       VALUES ($1, current_date, 'life-chronicle:event:projected', 'already projected', $1)`,
      [page.id],
    );
    const findings = await collectChronicle.collect(ctx());
    expect(findings.find((f) => f.id === 'chronicle_coverage_gap')).toBeUndefined();
  });
});

describe('知识库体检 apply contract', () => {
  test('runAdvisor reports a real coverage gap that --apply cannot execute', async () => {
    await engine.putPage('meetings/recent', { type: 'meeting', title: 'recent', compiled_truth: 'x'.repeat(120) });
    const report = await runAdvisor(ctx());
    const gap = report.findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeTruthy();
    expect(resolveApplyTarget(report, 'chronicle_backfill').ok).toBe(false);
    expect(resolveApplyTarget(report, 'chronicle-backfill').ok).toBe(false);
    const view = buildAdvisorProductView(report, 88);
    expect(view.product_name).toBe('知识库体检');
    expect(view.suggestions.find((item) => item.id === 'chronicle_coverage_gap')?.action_kind).toBe('none');
  });
});
