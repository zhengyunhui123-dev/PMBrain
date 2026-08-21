/**
 * Bounded, single-lock drain for the extract_atoms page backlog.
 *
 * Each batch rediscovers eligible pages. The cycle lock stays held across the
 * whole window, preventing a routine cycle from mutating the same Source in a
 * release/reacquire gap.
 */

import type { BrainEngine } from '../engine.ts';

export interface ExtractAtomsDrainDeps {
  withLock: <T>(work: () => Promise<T>) => Promise<T>;
  runBatch: () => Promise<{ extracted: number; skipped: number; providerFailure?: boolean }>;
  countRemaining: () => Promise<number | null>;
  now: () => number;
  onBatch?: (info: { batch: number; extracted: number; remaining: number | null }) => void;
}

export interface ExtractAtomsDrainOpts {
  windowMs: number;
  maxBatches?: number;
}

export interface ExtractAtomsDrainResult {
  phase: 'extract_atoms';
  status: 'ok' | 'provider_failure';
  extracted: number;
  skipped: number;
  remaining: number | null;
  batches: number;
  stopped: 'drained' | 'window' | 'no_progress' | 'max_batches' | 'provider_failure';
}

export async function runExtractAtomsDrain(
  deps: ExtractAtomsDrainDeps,
  opts: ExtractAtomsDrainOpts,
): Promise<ExtractAtomsDrainResult> {
  const maxBatches = opts.maxBatches ?? 1000;
  return deps.withLock(async () => {
    const deadline = deps.now() + Math.max(0, opts.windowMs);
    let extracted = 0;
    let skipped = 0;
    let batches = 0;
    let stopped: ExtractAtomsDrainResult['stopped'] = 'window';
    let providerFailure = false;

    while (deps.now() < deadline) {
      if (batches >= maxBatches) {
        stopped = 'max_batches';
        break;
      }

      const before = await deps.countRemaining();
      if (before === 0) {
        stopped = 'drained';
        break;
      }

      const result = await deps.runBatch();
      extracted += result.extracted;
      skipped += result.skipped;
      batches++;
      deps.onBatch?.({ batch: batches, extracted: result.extracted, remaining: before });

      if (result.providerFailure) {
        providerFailure = true;
        stopped = 'provider_failure';
        break;
      }

      // A zero-atom batch can still mark zero-yield pages as scanned. Only
      // stop when the observable backlog also failed to shrink.
      if (result.extracted === 0 && result.skipped === 0) {
        const after = await deps.countRemaining();
        if (after === null || before === null || after >= before) {
          stopped = 'no_progress';
          break;
        }
      }
    }

    const remaining = await deps.countRemaining();
    if (!providerFailure && remaining === 0) stopped = 'drained';
    return {
      phase: 'extract_atoms',
      status: providerFailure ? 'provider_failure' : 'ok',
      extracted,
      skipped,
      remaining,
      batches,
      stopped,
    };
  });
}

export interface DrainForSourceOpts {
  sourceId: string | undefined;
  windowSeconds: number;
  brainDir?: string;
  maxBatches?: number;
  onBatch?: ExtractAtomsDrainDeps['onBatch'];
}

/** Shared production wiring for CLI, durable jobs and autopilot. */
export async function runExtractAtomsDrainForSource(
  engine: BrainEngine,
  opts: DrainForSourceOpts,
): Promise<ExtractAtomsDrainResult> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');
  const { countExtractAtomsBacklog, runPhaseExtractAtoms } = await import('./extract-atoms.ts');
  const extractionSourceId = opts.sourceId ?? 'default';

  return runExtractAtomsDrain({
    withLock: work => withRefreshingLock(
      engine,
      cycleLockIdFor(opts.sourceId),
      work,
      { ttlMinutes: 5 },
    ),
    runBatch: async () => {
      const result = await runPhaseExtractAtoms(engine, {
        sourceId: extractionSourceId,
        dryRun: false,
        brainDir: opts.brainDir,
      });
      const details = (result.details ?? {}) as Record<string, unknown>;
      const failures = Array.isArray(details.failures) ? details.failures : [];
      const succeeded = Number(details.transcripts_processed ?? 0)
        + Number(details.pages_processed ?? 0);
      return {
        extracted: Number(details.atoms_extracted ?? 0),
        skipped: Number(details.duplicates_skipped ?? 0),
        providerFailure: failures.length > 0 && succeeded === 0,
      };
    },
    countRemaining: () => countExtractAtomsBacklog(engine, extractionSourceId),
    now: Date.now,
    onBatch: opts.onBatch,
  }, {
    windowMs: Math.max(0, opts.windowSeconds) * 1000,
    maxBatches: opts.maxBatches,
  });
}
