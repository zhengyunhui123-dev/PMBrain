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
  type PhaseResult,
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
    // Quick Maintenance is the product's one-click Source sync. Keep the
    // generic cycle default unchanged, but include committed local documents
    // here just like Admin's direct import flow does.
    includeOffice: true,
    // Undefined means drain every pending deterministic relation in this
    // Source. Explicit caps remain available to tests/advanced callers.
    markdownCatchUpMaxHistorical: opts.markdownCatchUpMaxHistorical,
    byMentionTimeBudgetMs: opts.byMentionTimeBudgetMs,
  });
}

export interface QuickMaintenanceSourceReport {
  sourceId: string;
  report: CycleReport;
}

function mergedPhaseStatus(phases: PhaseResult[]): PhaseResult['status'] {
  if (phases.every(phase => phase.status === 'skipped')) return 'skipped';
  if (phases.every(phase => phase.status === 'fail')) return 'fail';
  if (phases.some(phase => phase.status === 'fail' || phase.status === 'warn')) return 'warn';
  return 'ok';
}

function mergePhaseDetails(phases: PhaseResult[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const phase of phases) {
    for (const [key, value] of Object.entries(phase.details ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        merged[key] = Number(merged[key] ?? 0) + value;
      } else if (typeof value === 'boolean') {
        merged[key] = merged[key] === true || value;
      }
    }
  }
  return merged;
}

/**
 * Combine sequential per-Source Quick reports for the Admin one-click task.
 * The individual cycles remain Source-scoped; this only folds their receipts
 * into the existing CycleReport shape consumed by the Admin progress UI.
 */
export function combineQuickMaintenanceReports(
  reports: QuickMaintenanceSourceReport[],
  startedAt = new Date(),
): CycleReport {
  const totals = {} as CycleReport['totals'];
  for (const { report } of reports) {
    for (const [key, value] of Object.entries(report.totals)) {
      const totalKey = key as keyof CycleReport['totals'];
      totals[totalKey] = Number(totals[totalKey] ?? 0) + Number(value ?? 0);
    }
  }

  const phases = resolveQuickMaintenancePhases().map((phaseName) => {
    const sourcePhases = reports.flatMap(({ sourceId, report }) => {
      const phase = report.phases.find(item => item.phase === phaseName);
      return phase ? [{ sourceId, phase }] : [];
    });
    const phaseResults = sourcePhases.map(item => item.phase);
    const pagesAffected = sourcePhases.flatMap(({ sourceId, phase }) => {
      const slugs = (phase as PhaseResult & { pagesAffected?: string[] }).pagesAffected ?? [];
      return slugs.map(slug => `${sourceId}:${slug}`);
    });
    const failedSources = sourcePhases.filter(item => item.phase.status === 'fail').length;
    const details = {
      ...mergePhaseDetails(phaseResults),
      sources_processed: sourcePhases.length,
      sources_failed: failedSources,
      source_results: sourcePhases.map(({ sourceId, phase }) => ({
        source_id: sourceId,
        status: phase.status,
        summary: phase.summary,
      })),
    };
    return {
      phase: phaseName,
      status: mergedPhaseStatus(phaseResults),
      duration_ms: phaseResults.reduce((sum, phase) => sum + phase.duration_ms, 0),
      summary: `${sourcePhases.length - failedSources}/${sourcePhases.length} Source completed`,
      details,
      ...(pagesAffected.length > 0
        ? { pagesAffected: pagesAffected.slice(0, 100), pagesAffectedCount: pagesAffected.length }
        : {}),
      ...(phaseResults.find(phase => phase.error)?.error
        ? { error: phaseResults.find(phase => phase.error)?.error }
        : {}),
    } as PhaseResult;
  });

  const statuses = reports.map(item => item.report.status);
  const status: CycleReport['status'] = statuses.length === 0
    ? 'failed'
    : statuses.every(item => item === 'failed')
      ? 'failed'
      : statuses.some(item => item === 'failed' || item === 'partial' || item === 'skipped')
        ? 'partial'
        : statuses.some(item => item === 'ok')
          ? 'ok'
          : 'clean';

  return {
    schema_version: '1',
    timestamp: startedAt.toISOString(),
    duration_ms: reports.reduce((sum, item) => sum + item.report.duration_ms, 0),
    status,
    brain_dir: null,
    phases,
    totals,
  };
}
