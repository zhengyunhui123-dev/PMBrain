/**
 * PMBrain Quick Maintenance — thin orchestration over existing capabilities.
 *
 * Not a second Dream engine. Reuses runCycle + existing lint/sync/extract/
 * by-mention/embed/orphans cores. Full Dream stays on upstream phase tables.
 *
 * Goals:
 *   - failed sync files must not empty successful pagesAffected (sync layer)
 *   - deterministic by-mention relations for known entities
 *   - complete deterministic relation catch-up with resumable checkpoints
 *   - no generative LLM phases
 */

import type { BrainEngine } from './engine.ts';
import {
  runCycle,
  ALL_PHASES,
  type CycleOpts,
  type CyclePhase,
  type CycleReport,
} from './cycle.ts';

/** Quick phase set — same order as ALL_PHASES filter (legacy preset). */
export const QUICK_MAINTENANCE_PHASES: readonly CyclePhase[] = [
  'lint',
  'backlinks',
  'sync',
  'extract',
  'extract_facts',
  'resolve_symbol_edges',
  'embed',
  'orphans',
] as const;

const QUICK_PHASE_SET = new Set<CyclePhase>(QUICK_MAINTENANCE_PHASES);

/** Ordered Quick phases (ALWAYS derived from ALL_PHASES for Full-safe ordering). */
export function resolveQuickMaintenancePhases(): CyclePhase[] {
  return ALL_PHASES.filter((p) => QUICK_PHASE_SET.has(p));
}

export type QuickMaintenanceOpts = Omit<CycleOpts, 'phases' | 'includeByMention' | 'includeHistoricalMarkdownCatchUp' | 'forcePackPhases'>;

/**
 * Run one Quick Maintenance cycle.
 *
 * Thin wrapper: selects the Quick phase subset and enables by-mention on
 * the extract step. Does not reimplement sync/extract/embed.
 */
export async function runQuickMaintenance(
  engine: BrainEngine | null,
  opts: QuickMaintenanceOpts,
): Promise<CycleReport> {
  return runCycle(engine, {
    ...opts,
    phases: resolveQuickMaintenancePhases(),
    includeByMention: true,
    includeHistoricalMarkdownCatchUp: true,
    // Undefined means drain every pending deterministic relation in this
    // Source. Explicit caps remain available to tests/advanced callers.
    markdownCatchUpMaxHistorical: opts.markdownCatchUpMaxHistorical,
    byMentionTimeBudgetMs: opts.byMentionTimeBudgetMs,
  });
}
