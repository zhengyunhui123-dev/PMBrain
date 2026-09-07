import type { BrainEngine } from '../engine.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import { redactFindings } from '../secret-scan.ts';
import { ensureWellFormed, truncateUtf8 } from '../text-safe.ts';

export const MAX_DRAIN_FAILURE_RECORDS = 25;

export const MAX_DRAIN_FAILURE_SOURCE_CHARS = 256;
export const MAX_DRAIN_FAILURE_REASON_CHARS = 200;

export interface ExtractAtomsDrainFailure {

  batch: number;

  source: string;

  reason: string;
}

function sanitizeFailureText(raw: string, maxChars: number): string {
  const secretRedacted = redactFindings(raw, { highEntropy: true }).text;
  const connectionRedacted = redactConnectionInfo(secretRedacted);
  return truncateUtf8(
    ensureWellFormed(connectionRedacted).replace(/\s+/g, ' ').trim(),
    maxChars,
  );
}

export interface ExtractAtomsDrainDeps {

  withLock: <T>(work: () => Promise<T>) => Promise<T>;

  runBatch: () => Promise<{
    extracted: number;
    skipped: number;
    providerFailure?: boolean;
    failureCount?: number;
    firstError?: string;
    failures?: Array<{ source: string; reason: string }>;
  }>;

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

  failure_count: number;

  failures: ExtractAtomsDrainFailure[];

  omitted_failure_count: number;

  last_error: string | null;
}

export async function runExtractAtomsDrain(
  deps: ExtractAtomsDrainDeps,
  opts: ExtractAtomsDrainOpts,
): Promise<ExtractAtomsDrainResult> {
  const maxBatches = opts.maxBatches ?? 1000;
  return deps.withLock(async () => {
    const deadline = deps.now() + opts.windowMs;
    let extracted = 0;
    let skipped = 0;
    let batches = 0;
    let stopped: ExtractAtomsDrainResult['stopped'] = 'window';

    let providerFailure = false;

    let failureCount = 0;

    const failures: ExtractAtomsDrainFailure[] = [];
    let lastError: string | null = null;

    while (deps.now() < deadline) {
      if (batches >= maxBatches) { stopped = 'max_batches'; break; }

      const before = await deps.countRemaining();
      if (before === 0) { stopped = 'drained'; break; }

      const r = await deps.runBatch();
      extracted += r.extracted;
      skipped += r.skipped;
      batches++;

      const batchFailures = Array.isArray(r.failures)
        ? r.failures.filter(
            (f): f is { source: string; reason: string } =>
              f != null &&
              typeof f === 'object' &&
              typeof f.source === 'string' &&
              typeof f.reason === 'string',
          )
        : [];
      const reportedFailureCount =
        typeof r.failureCount === 'number' && Number.isFinite(r.failureCount) && r.failureCount > 0
          ? Math.floor(r.failureCount)
          : 0;
      failureCount += Math.max(reportedFailureCount, batchFailures.length);
      for (const f of batchFailures) {
        if (failures.length >= MAX_DRAIN_FAILURE_RECORDS) break;
        failures.push({
          batch: batches,
          source: sanitizeFailureText(f.source, MAX_DRAIN_FAILURE_SOURCE_CHARS),
          reason: sanitizeFailureText(f.reason, MAX_DRAIN_FAILURE_REASON_CHARS),
        });
      }
      const representative = batchFailures[0];
      if (representative) {
        lastError =
          `${sanitizeFailureText(representative.source, MAX_DRAIN_FAILURE_SOURCE_CHARS)}: ` +
          `${sanitizeFailureText(representative.reason, MAX_DRAIN_FAILURE_REASON_CHARS)}`;
      } else if (typeof r.firstError === 'string' && r.firstError.trim()) {

        lastError = sanitizeFailureText(
          r.firstError,
          MAX_DRAIN_FAILURE_SOURCE_CHARS + 2 + MAX_DRAIN_FAILURE_REASON_CHARS,
        );
      }
      deps.onBatch?.({ batch: batches, extracted: r.extracted, remaining: before });

      if (r.providerFailure) {
        providerFailure = true;
        stopped = 'provider_failure';
        break;
      }

      //

      if (r.extracted === 0 && r.skipped === 0) {
        const after = await deps.countRemaining();
        if (after === null || before === null || after >= before) { stopped = 'no_progress'; break; }
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
      failure_count: failureCount,
      failures,
      omitted_failure_count: failureCount - failures.length,
      last_error: lastError,
    };
  });
}

//

//

//

export interface DrainForSourceOpts {

  sourceId: string | undefined;

  windowSeconds: number;

  brainDir?: string;

  maxBatches?: number;

  onBatch?: ExtractAtomsDrainDeps['onBatch'];
}

export async function runExtractAtomsDrainForSource(
  engine: BrainEngine,
  opts: DrainForSourceOpts,
): Promise<ExtractAtomsDrainResult> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { runPhaseExtractAtoms, countExtractAtomsBacklog } = await import('./extract-atoms.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');

  const extractionSourceId = opts.sourceId ?? 'default';
  const lockId = cycleLockIdFor(opts.sourceId);

  return runExtractAtomsDrain(
    {
      withLock: (work) => withRefreshingLock(engine, lockId, work, { ttlMinutes: 5 }),
      runBatch: async () => {
        const r = await runPhaseExtractAtoms(engine, {
          sourceId: extractionSourceId,
          dryRun: false,
          brainDir: opts.brainDir,
        });
        const d = (r.details ?? {}) as Record<string, unknown>;

        const failures = Array.isArray(d.failures) ? d.failures : [];
        const itemsSucceeded =
          Number(d.transcripts_processed ?? 0) + Number(d.pages_processed ?? 0);

        const typedFailures = failures
          .filter(
            (f): f is { source: string; error: string } =>
              f != null &&
              typeof f === 'object' &&
              typeof (f as { source?: unknown }).source === 'string' &&
              typeof (f as { error?: unknown }).error === 'string',
          )
          .map(({ source, error }) => ({ source, reason: error }));
        return {
          extracted: Number(d.atoms_extracted ?? 0),
          skipped: Number(d.duplicates_skipped ?? 0),
          providerFailure: failures.length > 0 && itemsSucceeded === 0,
          failureCount: failures.length,
          failures: typedFailures,
        };
      },
      countRemaining: () => countExtractAtomsBacklog(engine, extractionSourceId),
      now: Date.now,
      onBatch: opts.onBatch,
    },
    { windowMs: opts.windowSeconds * 1000, maxBatches: opts.maxBatches },
  );
}
