/**
 * v0.12.2 migration orchestrator - JSONB double-encode repair.
 *
 * Runs entirely in-process so the packaged desktop first-run flow never
 * depends on PATH or a legacy gbrain executable.
 */

import { repairJsonb } from '../repair-jsonb.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { runSchemaMigration } from './helpers.ts';

async function phaseASchema(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  return runSchemaMigration(opts);
}

async function phaseBRepair(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'jsonb_repair', status: 'skipped', detail: 'dry-run' };
  try {
    const result = await repairJsonb({ dryRun: false });
    return {
      name: 'jsonb_repair',
      status: 'complete',
      detail: `${result.total_repaired} rows repaired on ${result.engine}`,
    };
  } catch (e) {
    return { name: 'jsonb_repair', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function phaseCVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    const result = await repairJsonb({ dryRun: true });
    if (result.total_repaired > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${result.total_repaired} string-typed JSONB rows remain after repair`,
      };
    }
    return { name: 'verify', status: 'complete', detail: `engine=${result.engine}` };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.12.2 - JSONB double-encode repair ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed');

  const b = await phaseBRepair(opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed');

  const c = await phaseCVerify(opts);
  phases.push(c);

  return finalizeResult(phases, c.status === 'failed' ? 'partial' : 'complete');
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
): OrchestratorResult {
  return {
    version: '0.12.2',
    status,
    phases,
  };
}

export const v0_12_2: Migration = {
  version: '0.12.2',
  featurePitch: {
    headline: 'Postgres frontmatter queries now work - JSONB double-encode bug fixed and existing rows auto-repaired',
    description:
      'PMBrain v0.12.0-and-earlier could store JSONB columns as quoted string literals on ' +
      'Postgres/Supabase (PGLite was unaffected). v0.12.2 fixes the writes and auto-repairs ' +
      'existing string-typed rows in pages.frontmatter, raw_data.data, ingest_log.pages_updated, ' +
      'files.metadata, and page_versions.frontmatter. The migration is idempotent; run ' +
      '`pmbrain sync --full` afterward only if you need to rebuild source-derived rows.',
  },
  orchestrator,
};

export const __testing = {
  phaseASchema,
  phaseBRepair,
  phaseCVerify,
};
