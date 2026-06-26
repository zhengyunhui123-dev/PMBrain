import { describe, expect, test } from 'bun:test';
import { rankFindings, runAdvisor } from '../src/core/advisor/run.ts';
import { collectUsageShape } from '../src/core/advisor/collect-usage-shape.ts';
import { collectStalledJobs } from '../src/core/advisor/collect-stalled-jobs.ts';
import { collectSetupSmells } from '../src/core/advisor/collect-setup-smells.ts';
import { renderAdvisorReport } from '../src/core/advisor/render.ts';
import type { AdvisorContext, AdvisorFinding } from '../src/core/advisor/types.ts';

function finding(over: Partial<AdvisorFinding>): AdvisorFinding {
  return { id: 'x', severity: 'info', title: 't', fix: { command_argv: null }, collector: 'usage-shape', ask_user: true, ...over };
}

function ctx(engine: Partial<AdvisorContext['engine']>, over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine: engine as AdvisorContext['engine'],
    config: {} as AdvisorContext['config'],
    version: '1.0.0',
    now: new Date('2026-06-26T00:00:00Z'),
    ...over,
  };
}

describe('rankFindings', () => {
  test('critical > warn > info, then collector order', () => {
    const ranked = rankFindings([
      finding({ id: 'i1', severity: 'info', collector: 'usage-shape' }),
      finding({ id: 'c1', severity: 'critical', collector: 'migration' }),
      finding({ id: 'w1', severity: 'warn', collector: 'schema-pack' }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['c1', 'w1', 'i1']);
  });

  test('info cap drops extra info but keeps criticals', () => {
    const fs: AdvisorFinding[] = [];
    for (let i = 0; i < 15; i++) fs.push(finding({ id: `i${i}`, severity: 'info' }));
    fs.push(finding({ id: 'crit', severity: 'critical', collector: 'migration' }));
    const ranked = rankFindings(fs, { infoCap: 3 });
    expect(ranked.filter((f) => f.severity === 'info')).toHaveLength(3);
    expect(ranked.find((f) => f.id === 'crit')).toBeDefined();
  });
});

describe('runAdvisor resilience', () => {
  test('does not throw when collectors hit engine errors', async () => {
    const engine = {
      getStats: async () => { throw new Error('boom'); },
      getHealth: async () => { throw new Error('boom'); },
      getConfig: async () => { throw new Error('boom'); },
      executeRaw: async () => { throw new Error('boom'); },
    };
    const report = await runAdvisor(ctx(engine));
    expect(Array.isArray(report.findings)).toBe(true);
  });
});

describe('collectors', () => {
  test('usage shape flags low embedding coverage and orphans', async () => {
    const engine = {
      getStats: async () => ({ page_count: 100, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
      getHealth: async () => ({
        page_count: 100,
        embed_coverage: 0.4,
        stale_pages: 0,
        orphan_pages: 5,
        missing_embeddings: 60,
        brain_score: 50,
        dead_links: 0,
        link_coverage: 0,
        timeline_coverage: 0,
        most_connected: [],
        embed_coverage_score: 0,
        link_density_score: 0,
        timeline_coverage_score: 0,
        no_orphans_score: 0,
        no_dead_links_score: 0,
      }),
    };
    const out = await collectUsageShape.collect(ctx(engine as never));
    expect(out.map((f) => f.id)).toContain('low_embed_coverage');
    expect(out.map((f) => f.id)).toContain('orphan_pages');
  });

  test('stalled jobs collector tolerates absent table', async () => {
    const engine = { executeRaw: async () => { throw new Error('missing'); } };
    expect(await collectStalledJobs.collect(ctx(engine as never))).toEqual([]);
  });

  test('setup smells flags disabled embeddings', async () => {
    const engine = { getConfig: async () => null };
    const out = await collectSetupSmells.collect(ctx(engine as never, { config: { embedding_disabled: true } as AdvisorContext['config'] }));
    expect(out.find((f) => f.id === 'embeddings_disabled')).toBeDefined();
  });
});

describe('renderAdvisorReport', () => {
  test('healthy report renders all-clear', () => {
    const txt = renderAdvisorReport({ version: '1.0.0', generated_at: 'x', findings: [], worst: null });
    expect(txt).toContain('looks healthy');
  });
});
