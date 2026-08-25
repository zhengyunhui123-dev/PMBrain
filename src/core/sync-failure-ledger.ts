// Source-scoped bounded sync failure ledger, aligned with current GBrain's
// failure state machine. Infrastructure failures remain fail-closed.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { gbrainPath } from './config.ts';

export const DEFAULT_SOURCE_ID = 'default';
export const DEFAULT_AUTOSKIP_AFTER = 3;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export type SyncFailureState = 'open' | 'acknowledged' | 'auto_skipped';

export interface SyncFailure {
  source_id: string;
  path: string;
  error: string;
  code: string;
  commit: string;
  line?: number;
  first_seen: string;
  ts: string;
  attempts: number;
  state: SyncFailureState;
  resolved_at?: string;
  acknowledged?: boolean;
  acknowledged_at?: string | null;
}

export interface AcknowledgeResult {
  count: number;
  summary: Array<{ code: string; count: number }>;
}

export function isSkippablePath(path: string): boolean {
  return !path.startsWith('<');
}

export function resolveAutoSkipThreshold(): number {
  const raw = process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
  if (raw === undefined || raw === '') return DEFAULT_AUTOSKIP_AFTER;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_AUTOSKIP_AFTER;
}

export function classifyErrorCode(error: string): string {
  if (/slug.*does not match|SLUG_MISMATCH/i.test(error)) return 'SLUG_MISMATCH';
  if (/connection terminated|connection.*closed|ECONNRESET|database.*unavailable|DB_CONNECTION/i.test(error)) return 'DB_CONNECTION';
  if (/duplicate key value violates unique constraint|DB_DUPLICATE_KEY/i.test(error)) return 'DB_DUPLICATE_KEY';
  if (/canceling statement due to statement timeout|STATEMENT_TIMEOUT/i.test(error)) return 'STATEMENT_TIMEOUT';
  if (/YAML parse failed|YAML_PARSE/i.test(error)) return 'YAML_PARSE';
  if (/YAMLException|duplicated mapping key|YAML_DUPLICATE_KEY/i.test(error)) return 'YAML_DUPLICATE_KEY';
  if (/File is empty or whitespace-only|Frontmatter must start with ---|MISSING_OPEN/i.test(error)) return 'MISSING_OPEN';
  if (/No closing --- delimiter|Heading at line .* found inside frontmatter|MISSING_CLOSE/i.test(error)) return 'MISSING_CLOSE';
  if (/Frontmatter block is empty|EMPTY_FRONTMATTER/i.test(error)) return 'EMPTY_FRONTMATTER';
  if (/Content contains null bytes|NULL_BYTES|null byte/i.test(error)) return 'NULL_BYTES';
  if (/Nested double quotes|NESTED_QUOTES/i.test(error)) return 'NESTED_QUOTES';
  if (/invalid UTF-?8|INVALID_UTF8/i.test(error)) return 'INVALID_UTF8';
  if (/file too large|content too large|FILE_TOO_LARGE/i.test(error)) return 'FILE_TOO_LARGE';
  if (/skipping symlink|symlink|SYMLINK_NOT_ALLOWED/i.test(error)) return 'SYMLINK_NOT_ALLOWED';
  if (/\[embed(?:Multimodal)?\([^)]*\).*\b(?:timed? ?out|timeout)\b|embedding request timeout|EMBEDDING_TIMEOUT/i.test(error)) return 'EMBEDDING_TIMEOUT';
  if (/\brate.?limit|\b429\b|too many requests|rate_limited|RateLimit/i.test(error)) return 'EMBEDDING_RATE_LIMIT';
  if (/insufficient_quota|quota exceeded|exceeded.*quota|credit balance is too low|billing|EMBEDDING_QUOTA/i.test(error)) return 'EMBEDDING_QUOTA';
  if (/embedding requires [A-Z][A-Z0-9_]+_API_KEY|EMBEDDING_NO_CREDS/i.test(error)) return 'EMBEDDING_NO_CREDS';
  if (/Anthropic has no embedding model|EMBEDDING_NO_TOUCHPOINT/i.test(error)) return 'EMBEDDING_NO_TOUCHPOINT';
  if (/maximum context length|max_tokens|context length|input too long|input length exceeds|tokens? exceed|too many tokens|EMBEDDING_OVERSIZE/i.test(error)) return 'EMBEDDING_OVERSIZE';
  if (/PAGE_JUNK_PATTERN/i.test(error)) return 'PAGE_JUNK_PATTERN';
  return 'UNKNOWN';
}

const INFRA_CODES = new Set([
  'DB_CONNECTION', 'DB_DUPLICATE_KEY', 'STATEMENT_TIMEOUT',
  'EMBEDDING_TIMEOUT', 'EMBEDDING_RATE_LIMIT', 'EMBEDDING_QUOTA', 'EMBEDDING_NO_CREDS',
]);

export function isInfrastructureFailureCode(code: string | undefined): boolean {
  return code !== undefined && INFRA_CODES.has(code);
}

export function summarizeFailuresByCode(failures: Array<{ error: string; code?: string }>): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const failure of failures) {
    const code = failure.code ?? classifyErrorCode(failure.error);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
}

export function formatCodeBreakdown(input: Array<{ error: string; code?: string }> | Array<{ code: string; count: number }>): string {
  const summary = input.length > 0 && 'count' in input[0]
    ? input as Array<{ code: string; count: number }>
    : summarizeFailuresByCode(input as Array<{ error: string; code?: string }>);
  return summary.map(({ code, count }) => `  ${code}: ${count}`).join('\n');
}

function failuresDir(): string {
  return process.env.GBRAIN_SYNC_FAILURES_DIR || gbrainPath();
}

export function syncFailuresPath(): string {
  return join(failuresDir(), 'sync-failures.jsonl');
}

function keyOf(sourceId: string, path: string): string {
  return `${sourceId}\u0000${path}`;
}

function applyLegacyMirror(row: SyncFailure): SyncFailure {
  row.acknowledged = row.state === 'acknowledged';
  row.acknowledged_at = row.state === 'acknowledged' ? (row.resolved_at ?? row.ts) : null;
  return row;
}

function normalize(raw: Record<string, unknown>): SyncFailure {
  const error = String(raw.error ?? '');
  const ts = typeof raw.ts === 'string' && raw.ts ? raw.ts : new Date(0).toISOString();
  const state: SyncFailureState = raw.state === 'open' || raw.state === 'acknowledged' || raw.state === 'auto_skipped'
    ? raw.state
    : raw.acknowledged === true || raw.acknowledged_at ? 'acknowledged' : 'open';
  return applyLegacyMirror({
    source_id: typeof raw.source_id === 'string' && raw.source_id ? raw.source_id : DEFAULT_SOURCE_ID,
    path: String(raw.path ?? ''),
    error,
    code: typeof raw.code === 'string' && raw.code ? raw.code : classifyErrorCode(error),
    commit: String(raw.commit ?? ''),
    line: typeof raw.line === 'number' ? raw.line : undefined,
    first_seen: typeof raw.first_seen === 'string' && raw.first_seen ? raw.first_seen : ts,
    ts,
    attempts: typeof raw.attempts === 'number' && raw.attempts > 0 ? Math.floor(raw.attempts) : 1,
    state,
    resolved_at: typeof raw.resolved_at === 'string'
      ? raw.resolved_at
      : typeof raw.acknowledged_at === 'string' ? raw.acknowledged_at : undefined,
  });
}

export function loadSyncFailures(): SyncFailure[] {
  if (!existsSync(syncFailuresPath())) return [];
  const groups = new Map<string, SyncFailure[]>();
  for (const line of readFileSync(syncFailuresPath(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = normalize(JSON.parse(line) as Record<string, unknown>);
      const key = keyOf(row.source_id, row.path);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    } catch {
      console.warn(`[sync-failures] skipping malformed line: ${line.slice(0, 120)}`);
    }
  }
  return [...groups.values()].map((rows) => {
    if (rows.length === 1) return rows[0];
    const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
    const latest = sorted.at(-1)!;
    const attempts = Math.max(...rows.map((row) => row.attempts), new Set(rows.map((row) => row.commit)).size);
    const state: SyncFailureState = rows.some((row) => row.state === 'open')
      ? 'open' : rows.some((row) => row.state === 'auto_skipped') ? 'auto_skipped' : 'acknowledged';
    return applyLegacyMirror({ ...latest, attempts, state, first_seen: sorted[0].first_seen });
  });
}

export function unacknowledgedSyncFailures(): SyncFailure[] {
  return loadSyncFailures().filter((row) => row.state !== 'acknowledged');
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLedgerLock<T>(fn: () => T): T {
  mkdirSync(failuresDir(), { recursive: true });
  const lock = `${syncFailuresPath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      closeSync(openSync(lock, 'wx'));
      acquired = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
        else sleep(50);
      } catch { /* lock disappeared; retry */ }
    }
  }
  if (!acquired) console.warn('[sync-failures] could not acquire ledger lock; proceeding best-effort');
  try { return fn(); }
  finally { if (acquired) try { unlinkSync(lock); } catch { /* already gone */ } }
}

function writeAll(rows: SyncFailure[]): void {
  mkdirSync(failuresDir(), { recursive: true });
  const target = syncFailuresPath();
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '');
  renameSync(temp, target);
}

function recordAndClear(sourceId: string, succeededPaths: string[], failures: Array<{ path: string; error: string; line?: number }>, commit: string): Map<string, number> {
  return withLedgerLock(() => {
    const rows = new Map(loadSyncFailures().map((row) => [keyOf(row.source_id, row.path), row]));
    let changed = false;
    for (const path of succeededPaths) changed = rows.delete(keyOf(sourceId, path)) || changed;
    const now = new Date().toISOString();
    for (const failure of failures) {
      const key = keyOf(sourceId, failure.path);
      const existing = rows.get(key);
      const code = classifyErrorCode(failure.error);
      const next = existing && existing.state === 'open' && existing.code === code
        ? { ...existing, attempts: existing.attempts + 1, ts: now, commit, error: failure.error, code, line: failure.line }
        : { source_id: sourceId, path: failure.path, error: failure.error, code, commit, line: failure.line, first_seen: now, ts: now, attempts: 1, state: 'open' as const };
      rows.set(key, applyLegacyMirror(next));
      changed = true;
    }
    if (changed) writeAll([...rows.values()]);
    return new Map(failures.map((failure) => [failure.path, rows.get(keyOf(sourceId, failure.path))?.attempts ?? 1]));
  });
}

export function recordFailures(sourceId: string, failures: Array<{ path: string; error: string; line?: number }>, commit: string): void {
  if (failures.length) recordAndClear(sourceId, [], failures, commit);
}

export function recordSyncFailures(failures: Array<{ path: string; error: string; line?: number }>, commit: string): void {
  recordFailures(DEFAULT_SOURCE_ID, failures, commit);
}

export function clearFailures(sourceId: string, paths: string[]): void {
  if (!paths.length) return;
  withLedgerLock(() => {
    const remove = new Set(paths.map((path) => keyOf(sourceId, path)));
    const rows = loadSyncFailures();
    const kept = rows.filter((row) => !remove.has(keyOf(row.source_id, row.path)));
    if (kept.length !== rows.length) writeAll(kept);
  });
}

function transition(sourceId: string | undefined, paths: string[] | null, state: 'acknowledged' | 'auto_skipped'): AcknowledgeResult {
  return withLedgerLock(() => {
    const rows = loadSyncFailures();
    const targets = paths ? new Set(paths.filter(isSkippablePath)) : null;
    const changed: SyncFailure[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      if (row.state !== 'open' && !(state === 'acknowledged' && row.state === 'auto_skipped')) continue;
      if (sourceId !== undefined && row.source_id !== sourceId) continue;
      if (!isSkippablePath(row.path) || (targets && !targets.has(row.path))) continue;
      row.state = state;
      row.resolved_at = now;
      applyLegacyMirror(row);
      changed.push(row);
    }
    if (changed.length) writeAll(rows);
    return { count: changed.length, summary: summarizeFailuresByCode(changed) };
  });
}

export function acknowledgeFailures(sourceId?: string): AcknowledgeResult {
  return transition(sourceId, null, 'acknowledged');
}

export function acknowledgeSyncFailures(): AcknowledgeResult {
  return acknowledgeFailures(undefined);
}

export function autoSkipFailures(sourceId: string, paths: string[]): AcknowledgeResult {
  return transition(sourceId, paths, 'auto_skipped');
}

export interface SyncGateInput {
  sourceId: string;
  failedFiles: Array<{ path: string; error: string; line?: number }>;
  succeededPaths: string[];
  commit: string;
  skipFailed: boolean;
  threshold?: number;
  advance: () => Promise<void> | void;
}

export interface SyncGateOutcome {
  advanced: boolean;
  sentinelBlocked: boolean;
  fresh: number;
  chronic: number;
  autoSkipped: string[];
  acknowledged: number;
}

export async function applySyncFailureGate(input: SyncGateInput): Promise<SyncGateOutcome> {
  const threshold = input.threshold ?? resolveAutoSkipThreshold();
  const attempts = recordAndClear(input.sourceId, input.succeededPaths, input.failedFiles, input.commit);
  const sentinels = input.failedFiles.filter((failure) => !isSkippablePath(failure.path));
  const fileFailures = input.failedFiles.filter((failure) => isSkippablePath(failure.path));
  const chronic = fileFailures.filter((failure) => (attempts.get(failure.path) ?? 1) >= threshold && threshold > 0);
  const fresh = fileFailures.length - chronic.length;
  const infrastructure = fileFailures.some((failure) => isInfrastructureFailureCode(classifyErrorCode(failure.error)));
  if (sentinels.length || infrastructure || (!input.skipFailed && (threshold <= 0 || fresh > 0))) {
    return { advanced: false, sentinelBlocked: sentinels.length > 0, fresh, chronic: chronic.length, autoSkipped: [], acknowledged: 0 };
  }
  await input.advance();
  if (input.skipFailed) {
    const acknowledged = acknowledgeFailures(input.sourceId).count;
    return { advanced: true, sentinelBlocked: false, fresh, chronic: chronic.length, autoSkipped: [], acknowledged };
  }
  const autoSkipped = chronic.map((failure) => failure.path);
  autoSkipFailures(input.sourceId, autoSkipped);
  return { advanced: true, sentinelBlocked: false, fresh, chronic: chronic.length, autoSkipped, acknowledged: 0 };
}

export function decideSyncFailureSeverity(args: { entries: SyncFailure[]; nowMs: number; failHours: number }): { status: 'ok' | 'warn' | 'fail'; unresolved: number; open: number; auto_skipped: number } {
  const unresolved = args.entries.filter((row) => row.state !== 'acknowledged');
  const openRows = unresolved.filter((row) => row.state === 'open');
  const oldOpen = openRows.some((row) => {
    const timestamp = Date.parse(row.ts);
    return Number.isFinite(timestamp) && args.nowMs - timestamp > args.failHours * 3_600_000;
  });
  return {
    status: unresolved.length === 0 ? 'ok' : openRows.length >= 10 || oldOpen ? 'fail' : 'warn',
    unresolved: unresolved.length,
    open: openRows.length,
    auto_skipped: unresolved.length - openRows.length,
  };
}
