/**
 * v0.13.0 migration orchestrator - frontmatter relationship indexing.
 *
 * Runs entirely in-process so desktop first-run does not depend on PATH or a
 * legacy gbrain executable.
 */

import { extractLinksFromDB } from '../extract.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { closeMigrationEngine, createMigrationEngine, runSchemaMigration } from './helpers.ts';

async function phaseASchema(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  return runSchemaMigration(opts);
}

async function phaseBBackfill(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'frontmatter_backfill', status: 'skipped', detail: 'dry-run' };

  const engine = await createMigrationEngine();
  try {
    const result = await extractLinksFromDB(
      engine,
      false,
      true,
      undefined,
      undefined,
      { includeFrontmatter: true },
    );
    return {
      name: 'frontmatter_backfill',
      status: 'complete',
      detail: `${result.created} links from ${result.pages} pages`,
    };
  } catch (e) {
    return { name: 'frontmatter_backfill', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await closeMigrationEngine(engine);
  }
}

async function phaseCVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };

  const engine = await createMigrationEngine();
  try {
    const stats = await engine.getStats();
    return {
      name: 'verify',
      status: 'complete',
      detail: `pages=${stats.page_count}, links=${stats.link_count} (backfill output in Phase B logs)`,
    };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await closeMigrationEngine(engine);
  }
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.13.0 - Frontmatter relationship indexing ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed');

  const b = await phaseBBackfill(opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'partial');

  const c = await phaseCVerify(opts);
  phases.push(c);

  return finalizeResult(phases, c.status === 'failed' ? 'partial' : 'complete');
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
): OrchestratorResult {
  return {
    version: '0.13.0',
    status,
    phases,
  };
}

export const v0_13_0: Migration = {
  version: '0.13.0',
  featurePitch: {
    headline: 'Frontmatter becomes a graph - company, investors, attendees now create typed edges automatically',
    description:
      'v0.13 extends the knowledge graph to project typed edges from YAML frontmatter. ' +
      'Every company, investors, attendees, key_people, partner, lead, and related field ' +
      'can now surface in the PMBrain graph. The migration backfills existing pages using ' +
      'the in-process extractor, with zero external CLI dependency.',
  },
  orchestrator,
};

export const __testing = {
  phaseASchema,
  phaseBBackfill,
  phaseCVerify,
};
