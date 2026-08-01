/**
 * PGLite File Lock — exclusive single-owner advisory lock for a data directory.
 *
 * PGLite (embedded Postgres/WASM) supports only one process per data directory.
 * This module uses atomic `mkdir` (O_EXCL semantics) plus rich lock metadata so
 * Windows PID reuse, reboot-stale locks, and corrupt metadata can be distinguished
 * from a truly live owner.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 *
 * Ownership rules (never use lock age alone to steal):
 * 1. No lock → create.
 * 2. Corrupt metadata → archive, then compete again.
 * 3. Different bootMarker → previous boot residue → archive.
 * 4. PID gone → residue → archive.
 * 5. PID alive but processStartTime mismatch → PID reuse → archive.
 * 6. PID alive but executable is not a PMBrain owner → reuse/mismatch → archive.
 * 7. PID + startTime + token identity of a live PMBrain process → refuse.
 */

<<<<<<< HEAD
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  createDefaultProcessInspector,
  looksLikePmbrainExecutable,
  type ProcessInspector,
} from './pglite-process-inspector.ts';
import { DatabaseAlreadyOwnedError, PgliteLockMetadataError } from './pglite-errors.ts';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';
const LOCK_SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMPETE_ATTEMPTS = 8;
const RETRY_WAIT_MS = 500;

export type LockOwnerType =
  | 'desktop-sidecar'
  | 'cli'
  | 'probe'
  | 'migration'
  | 'test'
  | 'unknown';

export interface LockMetadataV2 {
  schemaVersion: 2;
  pid: number;
  processStartTime: string | null;
  bootMarker: string;
  ownerToken: string;
  ownerType: LockOwnerType;
  databasePath: string;
  executablePath: string | null;
  command?: string;
  createdAt: string;
  updatedAt: string;
  /** Legacy field kept for older readers / diagnostics. */
  acquired_at?: number;
}

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  ownerToken?: string;
  metadata?: LockMetadataV2;
  diagnostics?: LockDiagnostics;
}

export type LockDecision =
  | 'acquire_new'
  | 'archive_stale_lock'
  | 'reject_active_owner'
  | 'retry_race'
  | 'skip_in_memory';

export interface LockDiagnostics {
  databasePath: string;
  lockPath: string;
  lockExists: boolean;
  lockMetadata: Partial<LockMetadataV2> | null;
  currentBootMarker: string;
  lockBootMarkerMatches: boolean | null;
  pidExists: boolean | null;
  processStartMatches: boolean | null;
  executableMatches: boolean | null;
  decision: LockDecision;
  reason: string;
  archivedTo?: string;
}

export interface AcquireLockOptions {
  timeoutMs?: number;
  ownerType?: LockOwnerType;
  inspector?: ProcessInspector;
  /** When true, throw immediately if a live owner is detected (no wait). */
  failFastIfOwned?: boolean;
  /** Optional command/argv summary for diagnostics (never secrets). */
  command?: string;
}

let defaultInspector: ProcessInspector | null = null;

export function setDefaultProcessInspector(inspector: ProcessInspector | null): void {
  defaultInspector = inspector;
}

function resolveInspector(inspector?: ProcessInspector): ProcessInspector {
  return inspector ?? defaultInspector ?? createDefaultProcessInspector();
}

function getLockDir(dataDir: string | undefined): string {
  if (!dataDir) return '';
=======
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { parseGlobalFlags } from './cli-options.ts';

const LOCK_DIR_NAME = '.gbrain-lock';
const LOCK_FILE = 'lock';

export type PgliteLockRole = 'desktop-sidecar' | 'serve' | 'cli' | 'migration';

export interface AcquireLockOptions {
  timeoutMs?: number;
  role?: PgliteLockRole;
}

interface LockRecord {
  pid: number;
  acquired_at: number;
  refreshed_at: number;
  command: string;
  subcommand: string | null;
  role: PgliteLockRole;
  owner_token: string;
}

const VALID_ROLES = new Set<PgliteLockRole>(['desktop-sidecar', 'serve', 'cli', 'migration']);
const MIGRATION_COMMANDS = new Set(['init', 'migrate', 'apply-migrations', 'reinit-pglite', 'pglite-backup']);

// #2058: refresh the lock's `refreshed_at` while held so a long-running but
// LIVE holder (embed jobs run for many minutes) is never mistaken for stale.
const HEARTBEAT_INTERVAL_MS = 30_000;

class LiveServeLockError extends Error {}
class PgliteLockMetadataError extends Error {}

function isServeCommand(lockData: { role?: unknown; subcommand?: unknown; command?: unknown }): boolean {
  // New lock files store the command after the same global-flag parsing used
  // by cli.ts. This survives paths with spaces and forms such as
  // `gbrain --quiet serve` without confusing `gbrain search serve`.
  if (lockData.role === 'desktop-sidecar' || lockData.role === 'serve') return true;
  if (typeof lockData.subcommand === 'string') return lockData.subcommand === 'serve';

  const command = lockData.command;
  if (typeof command !== 'string') return false;
  const parts = command.trim().split(/\s+/);
  // Backward compatibility for locks created before `subcommand` was stored.
  return parts[0] === 'serve' || parts[1] === 'serve';
}

function resolveLockRole(subcommand: string | null, explicit?: PgliteLockRole): PgliteLockRole {
  if (explicit) return explicit;
  const fromEnv = process.env.PMBRAIN_PGLITE_ROLE;
  if (fromEnv && VALID_ROLES.has(fromEnv as PgliteLockRole)) return fromEnv as PgliteLockRole;
  if (subcommand === 'serve') return 'serve';
  if (subcommand && MIGRATION_COMMANDS.has(subcommand)) return 'migration';
  return 'cli';
}

// #2348: there is NO steal-on-stale-heartbeat anymore. A holder whose PID is
// alive is NEVER reaped, regardless of how long its heartbeat has been stale.
// PGLite/WASM is strictly single-writer; the heartbeat runs on the JS event
// loop, which is BLOCKED during long synchronous imports/CHECKPOINTs, so a
// genuinely working `gbrain dream`/embed holder can look stale while alive.
// Reaping it (the old #2058 grace window) let a second OS process open the same
// data dir and corrupt the catalog + pgvector extension state (58P01 /
// internal_load_library / `type "vector" does not exist`), recoverable only by
// wipe+restore. Only a DEAD PID is reaped now. A live serve-tagged holder gets
// the immediate process-conflict explanation below; other wedged-but-alive or
// PID-reused holders time out. Neither path steals the lock.

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
  /**
   * #2058: heartbeat timer + lock-file path, set when a real (on-disk) lock is
   * held so `releaseLock` can stop refreshing. Absent for the in-memory engine
   * (no lock file, no concurrent access possible).
   */
  heartbeat?: ReturnType<typeof setInterval>;
  lockPath?: string;
  /**
   * Our random ownership token. Since #2348 a LIVE holder is
   * never reaped, so reap-then-reacquire happens only after the original holder
   * is dead — but the heartbeat and release STILL verify the on-disk lock is
   * ours before touching it (defense-in-depth: a crash-then-restart on a reused
   * PID, or a misclassification, must never let a stale handle refresh or delete
   * the NEW owner's live lock and re-open the concurrent-writer hole).
   */
  ownerToken?: string;
}

/** The on-disk lock identity, used to detect "we were reaped and replaced". */
function tokenOf(lockData: { owner_token?: unknown; pid?: unknown; acquired_at?: unknown }): string {
  if (typeof lockData.owner_token === 'string' && lockData.owner_token) {
    return lockData.owner_token;
  }
  return `${lockData.pid}:${lockData.acquired_at}`;
}

/**
 * #2058: keep the held lock's `refreshed_at` current so a concurrent acquirer
 * can tell a live, working holder from a hung/dead one. Best-effort: if the
 * file is gone (we're being reaped) the write simply fails. `.unref()` so the
 * timer never keeps the process alive on its own. Ownership-checked: if the
 * on-disk lock is no longer ours (for example, after dead-owner recovery), stop
 * the heartbeat instead of clobbering the new owner's lock.
 */
function startHeartbeat(lockPath: string, ownerToken: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (tokenOf(raw) !== ownerToken) {
        // We were reaped and someone else owns it now — do NOT refresh their
        // lock. Stand down.
        clearInterval(timer);
        return;
      }
      raw.refreshed_at = Date.now();
      writeFileSync(lockPath, JSON.stringify(raw), { mode: 0o644 });
    } catch { /* best-effort — file removed or transient FS error */ }
  }, HEARTBEAT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function getLockDir(dataDir: string | undefined): string {
  // Store the compatibility lock directory inside the PGLite data directory.
  if (!dataDir) {
    // In-memory PGLite — no concurrent access possible since it's process-scoped
    // Return a sentinel that we skip
    return '';
  }
>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
  return join(dataDir, LOCK_DIR_NAME);
}

function lockFilePath(lockDir: string): string {
  return join(lockDir, LOCK_FILE);
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatArchiveStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function redactPath(pathValue: string): string {
  // Keep basename context; collapse long user-home prefixes for logs.
  return pathValue
    .replace(/\\/g, '/')
    .replace(/\/Users\/[^/]+/gi, '/Users/<user>')
    .replace(/\/home\/[^/]+/gi, '/home/<user>')
    .replace(/\/[A-Za-z]:\/Users\/[^/]+/gi, '/<drive>/Users/<user>')
    .replace(/[A-Za-z]:\/Users\/[^/]+/gi, '<drive>/Users/<user>');
}

function safeJsonParse(text: string): unknown {
  try {
<<<<<<< HEAD
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeMetadata(raw: unknown, databasePath: string): Partial<LockMetadataV2> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const pid = typeof obj.pid === 'number' ? obj.pid : Number(obj.pid);
  if (!Number.isFinite(pid)) return null;

  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;
  const createdAt = typeof obj.createdAt === 'string'
    ? obj.createdAt
    : typeof obj.acquired_at === 'number'
      ? new Date(obj.acquired_at).toISOString()
      : null;

  return {
    schemaVersion: schemaVersion === 2 ? 2 : (schemaVersion as 2),
    pid,
    processStartTime: typeof obj.processStartTime === 'string' ? obj.processStartTime : null,
    bootMarker: typeof obj.bootMarker === 'string' ? obj.bootMarker : '',
    ownerToken: typeof obj.ownerToken === 'string' ? obj.ownerToken : '',
    ownerType: (typeof obj.ownerType === 'string' ? obj.ownerType : 'unknown') as LockOwnerType,
    databasePath: typeof obj.databasePath === 'string' ? obj.databasePath : databasePath,
    executablePath: typeof obj.executablePath === 'string' ? obj.executablePath : null,
    command: typeof obj.command === 'string' ? obj.command : undefined,
    createdAt: createdAt ?? nowIso(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : createdAt ?? nowIso(),
    acquired_at: typeof obj.acquired_at === 'number' ? obj.acquired_at : undefined,
  };
}

async function evaluateExistingLock(
  dataDir: string,
  lockDir: string,
  inspector: ProcessInspector,
): Promise<{ decision: 'active' | 'stale' | 'corrupt'; reason: string; metadata: Partial<LockMetadataV2> | null; diagnostics: LockDiagnostics }> {
  const lockPath = lockFilePath(lockDir);
  const currentBootMarker = await inspector.getBootMarker();
  const baseDiag: LockDiagnostics = {
    databasePath: redactPath(dataDir),
    lockPath: redactPath(lockPath),
    lockExists: existsSync(lockDir),
    lockMetadata: null,
    currentBootMarker,
    lockBootMarkerMatches: null,
    pidExists: null,
    processStartMatches: null,
    executableMatches: null,
    decision: 'retry_race',
    reason: 'unknown',
  };

  if (!existsSync(lockPath)) {
    // Empty lock dir (race during write) — treat as corrupt residue.
    return {
      decision: 'corrupt',
      reason: 'missing_lock_file',
      metadata: null,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'missing_lock_file' },
    };
  }

  let rawText: string;
  try {
    rawText = readFileSync(lockPath, 'utf-8');
  } catch {
    return {
      decision: 'corrupt',
      reason: 'unreadable_lock_file',
      metadata: null,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'unreadable_lock_file' },
    };
  }

  const parsed = safeJsonParse(rawText);
  const metadata = normalizeMetadata(parsed, dataDir);
  if (!metadata || !Number.isFinite(metadata.pid)) {
    return {
      decision: 'corrupt',
      reason: 'corrupt_lock_metadata',
      metadata: null,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'corrupt_lock_metadata' },
    };
  }

  baseDiag.lockMetadata = {
    pid: metadata.pid,
    ownerType: metadata.ownerType,
    createdAt: metadata.createdAt,
    bootMarker: metadata.bootMarker,
    processStartTime: metadata.processStartTime,
    executablePath: metadata.executablePath ? redactPath(metadata.executablePath) : null,
    ownerToken: metadata.ownerToken ? '<redacted>' as unknown as string : '',
  };

  if (metadata.bootMarker && metadata.bootMarker !== currentBootMarker) {
    return {
      decision: 'stale',
      reason: 'previous_system_boot',
      metadata,
      diagnostics: {
        ...baseDiag,
        lockBootMarkerMatches: false,
        decision: 'archive_stale_lock',
        reason: 'previous_system_boot',
      },
    };
  }
  if (metadata.bootMarker) {
    baseDiag.lockBootMarkerMatches = true;
  }

  const pid = metadata.pid as number;
  const pidExists = await inspector.exists(pid);
  baseDiag.pidExists = pidExists;
  if (!pidExists) {
    return {
      decision: 'stale',
      reason: 'pid_not_running',
      metadata,
      diagnostics: { ...baseDiag, decision: 'archive_stale_lock', reason: 'pid_not_running' },
    };
  }

  const liveStart = await inspector.getStartTime(pid);
  if (metadata.processStartTime && liveStart && metadata.processStartTime !== liveStart) {
    return {
      decision: 'stale',
      reason: 'pid_reused_start_time_mismatch',
      metadata,
      diagnostics: {
        ...baseDiag,
        processStartMatches: false,
        decision: 'archive_stale_lock',
        reason: 'pid_reused_start_time_mismatch',
      },
    };
  }
  if (metadata.processStartTime && liveStart) {
    baseDiag.processStartMatches = true;
  } else if (metadata.processStartTime && !liveStart) {
    // Could not read live start time — fall through to executable checks.
    baseDiag.processStartMatches = null;
  }

  const liveExe = await inspector.getExecutablePath(pid);
  const lockExe = metadata.executablePath ?? null;
  const commandHint = metadata.command ?? null;

  if (liveExe && lockExe) {
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const matches = normalize(liveExe) === normalize(lockExe);
    baseDiag.executableMatches = matches;
    if (!matches) {
      return {
        decision: 'stale',
        reason: 'executable_path_mismatch',
        metadata,
        diagnostics: {
          ...baseDiag,
          decision: 'archive_stale_lock',
          reason: 'executable_path_mismatch',
        },
      };
    }
  } else if (liveExe && !looksLikePmbrainExecutable(liveExe, commandHint)) {
    baseDiag.executableMatches = false;
    return {
      decision: 'stale',
      reason: 'executable_not_pmbrain',
      metadata,
      diagnostics: {
        ...baseDiag,
        decision: 'archive_stale_lock',
        reason: 'executable_not_pmbrain',
      },
    };
  } else if (liveExe) {
    baseDiag.executableMatches = true;
  }

  // Live owner identity still valid. Age is irrelevant.
  return {
    decision: 'active',
    reason: 'owner_still_active',
    metadata,
    diagnostics: {
      ...baseDiag,
      decision: 'reject_active_owner',
      reason: 'owner_still_active',
    },
  };
}

function archiveLockDir(lockDir: string, reason: string): string {
  const parent = join(lockDir, '..');
  const stamp = formatArchiveStamp();
  const safeReason = reason.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
  let target = join(parent, `${LOCK_DIR_NAME}.stale-${stamp}-${safeReason}`);
  let n = 0;
  while (existsSync(target)) {
    n += 1;
    target = join(parent, `${LOCK_DIR_NAME}.stale-${stamp}-${safeReason}-${n}`);
  }
  try {
    renameSync(lockDir, target);
    return target;
  } catch {
    // If rename fails (race), leave it; caller will retry evaluation.
    return target;
  }
}

async function buildMetadata(
  dataDir: string,
  ownerType: LockOwnerType,
  inspector: ProcessInspector,
  command?: string,
): Promise<LockMetadataV2> {
  const createdAt = nowIso();
  const processStartTime = await inspector.getStartTime(process.pid);
  const executablePath = await inspector.getExecutablePath(process.pid);
  const bootMarker = await inspector.getBootMarker();
  const ownerToken = randomBytes(16).toString('hex');
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    processStartTime,
    bootMarker,
    ownerToken,
    ownerType,
    databasePath: dataDir,
    executablePath,
    command: command ?? process.argv.slice(1).join(' ').slice(0, 500),
    createdAt,
    updatedAt: createdAt,
    acquired_at: Date.now(),
  };
}

=======
    // Sending signal 0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this account cannot signal it.
    // Treat it as live: an unverifiable live holder must never be reaped.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function formatLockTimestamp(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : 'unknown time';
}

function pgliteLockTimeoutError(lockDir: string): Error {
  const lockPath = join(lockDir, LOCK_FILE);
  try {
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const pid = String(lockData.pid ?? 'unknown');
    const command = String(lockData.command ?? 'unknown');
    const role = String(lockData.role ?? 'legacy/unknown');
    return new Error(
      `PMBrain: Timed out waiting for PGLite data-dir lock. Process ${pid} has held it since ${formatLockTimestamp(lockData.acquired_at)} ` +
      `(role: ${role}, command: ${command}). Lock directory: ${lockDir}. ` +
      'The live holder was not preempted because PGLite is a single-owner embedded PostgreSQL database. ' +
      '请先正常退出该 PMBrain 实例（含桌面端托盘或命令行）后重试；不要在进程仍存活时删除锁目录。',
    );
  } catch {
    return pgliteLockMetadataError(lockDir, 'lock metadata is unreadable');
  }
}

function pgliteLockMetadataError(lockDir: string, reason: string): Error {
  return new PgliteLockMetadataError(
    `PMBrain: PGLite ${reason}. PMBrain will not delete ${lockDir} automatically because it cannot verify lock owner liveness. ` +
    '请先退出所有 PMBrain/GBrain 进程并核实任务管理器；确认没有进程使用该数据库后，再由人工处理残留锁。',
  );
}
>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 */
<<<<<<< HEAD
export async function acquireLock(
  dataDir: string | undefined,
  opts?: AcquireLockOptions,
): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);
=======
export async function acquireLock(dataDir: string | undefined, opts: AcquireLockOptions = {}): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
  if (!lockDir) {
    return {
      lockDir: '',
      acquired: true,
      diagnostics: {
        databasePath: '',
        lockPath: '',
        lockExists: false,
        lockMetadata: null,
        currentBootMarker: '',
        lockBootMarkerMatches: null,
        pidExists: null,
        processStartMatches: null,
        executableMatches: null,
        decision: 'skip_in_memory',
        reason: 'in_memory',
      },
    };
  }

  mkdirSync(dataDir as string, { recursive: true });
<<<<<<< HEAD
  const inspector = resolveInspector(opts?.inspector);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ownerType = opts?.ownerType ?? 'cli';
  const failFast = opts?.failFastIfOwned ?? false;
  const startTime = Date.now();
  let attempts = 0;
  let lastDiagnostics: LockDiagnostics | undefined;

  while (Date.now() - startTime < timeoutMs && attempts < MAX_COMPETE_ATTEMPTS + Math.floor(timeoutMs / RETRY_WAIT_MS)) {
    attempts += 1;

    if (existsSync(lockDir)) {
      const evaluation = await evaluateExistingLock(dataDir as string, lockDir, inspector);
      lastDiagnostics = evaluation.diagnostics;

      if (evaluation.decision === 'active') {
        if (failFast || Date.now() - startTime >= timeoutMs) {
          throw new DatabaseAlreadyOwnedError({
            databasePath: dataDir as string,
            lockPath: lockFilePath(lockDir),
            ownerPid: evaluation.metadata?.pid ?? null,
            ownerType: evaluation.metadata?.ownerType ?? null,
            executablePath: evaluation.metadata?.executablePath ?? null,
            lockCreatedAt: evaluation.metadata?.createdAt ?? null,
            ownerToken: evaluation.metadata?.ownerToken ?? null,
          });
        }
        await sleep(RETRY_WAIT_MS);
        continue;
=======

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const startTime = Date.now();
  const subcommand = parseGlobalFlags(process.argv.slice(2)).rest[0] ?? null;
  const role = resolveLockRole(subcommand, opts.role);

  while (Date.now() - startTime < timeoutMs) {
    if (existsSync(lockDir)) {
      const lockPath = join(lockDir, LOCK_FILE);
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<LockRecord>;
        const lockPid = lockData.pid;
        if (!Number.isInteger(lockPid) || (lockPid ?? 0) <= 0) {
          throw pgliteLockMetadataError(lockDir, 'lock metadata has no valid PID');
        }

        if (!isProcessAlive(lockPid as number)) {
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* acquisition race */ }
        } else {
          if (isServeCommand(lockData)) {
            const holderRole = String(lockData.role ?? 'serve/legacy');
            throw new LiveServeLockError(
              `PMBrain desktop sidecar/local service already owns this PGLite database (PID ${lockPid}, role: ${holderRole}). ` +
              'PGLite is a single-owner embedded PostgreSQL database, so a separate CLI process cannot open the same directory. ' +
              '请保持本地服务运行并通过 PMBrain/MCP 调用，或先正常退出桌面端（含托盘）后再执行 CLI。' +
              ` PMBrain will not remove ${lockDir} while that PID is alive.`,
            );
          }

          const elapsed = Date.now() - startTime;
          const remaining = timeoutMs - elapsed;
          if (remaining <= 0) break;
          await new Promise(r => setTimeout(r, Math.min(1_000, remaining)));
          continue;
        }
      } catch (err) {
        if (err instanceof LiveServeLockError || err instanceof PgliteLockMetadataError) throw err;
        throw pgliteLockMetadataError(lockDir, 'lock metadata is unreadable');
>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
      }

      // Stale or corrupt → archive (never permanent delete).
      const archivePath = archiveLockDir(lockDir, evaluation.reason);
      lastDiagnostics = {
        ...evaluation.diagnostics,
        decision: 'archive_stale_lock',
        reason: evaluation.reason,
        archivedTo: redactPath(archivePath),
      };
      // Proceed to atomic create below (lock dir should be gone).
    }

    try {
      mkdirSync(lockDir, { recursive: false });
<<<<<<< HEAD
      const metadata = await buildMetadata(dataDir as string, ownerType, inspector, opts?.command);
      writeFileSync(lockFilePath(lockDir), JSON.stringify(metadata, null, 2), { mode: 0o644 });
      const diagnostics: LockDiagnostics = {
        databasePath: redactPath(dataDir as string),
        lockPath: redactPath(lockFilePath(lockDir)),
        lockExists: true,
        lockMetadata: {
          pid: metadata.pid,
          ownerType: metadata.ownerType,
          createdAt: metadata.createdAt,
        },
        currentBootMarker: metadata.bootMarker,
        lockBootMarkerMatches: true,
        pidExists: true,
        processStartMatches: true,
        executableMatches: true,
        decision: 'acquire_new',
        reason: lastDiagnostics?.reason ? `after_${lastDiagnostics.reason}` : 'lock_absent',
        archivedTo: lastDiagnostics?.archivedTo,
      };
      return {
        lockDir,
        acquired: true,
        ownerToken: metadata.ownerToken,
        metadata,
        diagnostics,
      };
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Lost the race — loop and re-evaluate.
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `GBrain: Permission denied creating PGLite lock at ${lockDir}.`,
          { cause: e },
        );
      }
      // Other errors: brief retry then surface.
      if (Date.now() - startTime >= timeoutMs) throw e;
      await sleep(RETRY_WAIT_MS);
=======
    } catch {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) throw pgliteLockTimeoutError(lockDir);
      await new Promise(r => setTimeout(r, Math.min(500, timeoutMs - elapsed)));
      continue;
>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
    }

    const lockPath = join(lockDir, LOCK_FILE);
    const now = Date.now();
    const ownerToken = randomUUID();
    const lockRecord: LockRecord = {
      pid: process.pid,
      acquired_at: now,
      refreshed_at: now,
      command: process.argv.slice(1).join(' '),
      subcommand,
      role,
      owner_token: ownerToken,
    };
    try {
      writeFileSync(lockPath, JSON.stringify(lockRecord), { mode: 0o644 });
    } catch (err) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort own-lock cleanup */ }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`PMBrain: failed to persist PGLite lock metadata at ${lockPath}: ${detail}`);
    }

    return {
      lockDir,
      acquired: true,
      lockPath,
      ownerToken,
      heartbeat: startHeartbeat(lockPath, ownerToken),
    };
  }

<<<<<<< HEAD
  // Timeout — report current owner if any.
  if (existsSync(lockDir)) {
    const evaluation = await evaluateExistingLock(dataDir as string, lockDir, inspector);
    if (evaluation.decision === 'active') {
      throw new DatabaseAlreadyOwnedError({
        databasePath: dataDir as string,
        lockPath: lockFilePath(lockDir),
        ownerPid: evaluation.metadata?.pid ?? null,
        ownerType: evaluation.metadata?.ownerType ?? null,
        executablePath: evaluation.metadata?.executablePath ?? null,
        lockCreatedAt: evaluation.metadata?.createdAt ?? null,
        ownerToken: evaluation.metadata?.ownerToken ?? null,
      });
    }
  }

  throw new Error(
    `GBrain: Timed out waiting for PGLite lock on ${dataDir}.`
    + (lastDiagnostics ? ` Last decision: ${lastDiagnostics.decision}/${lastDiagnostics.reason}.` : '')
    + ` If no PMBrain process is running, inspect archived locks next to the database directory.`,
  );
=======
  throw pgliteLockTimeoutError(lockDir);
>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
}

/**
 * Release a previously acquired lock. Only succeeds when ownerToken matches
 * the on-disk lock (prevents an old process from deleting a newer owner's lock).
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (lock.heartbeat) {
    clearInterval(lock.heartbeat);
    lock.heartbeat = undefined;
  }
  if (!lock.lockDir || !lock.acquired) return;

<<<<<<< HEAD
  const path = lockFilePath(lock.lockDir);
  try {
    if (!existsSync(lock.lockDir)) return;

    if (lock.ownerToken && existsSync(path)) {
      const raw = safeJsonParse(readFileSync(path, 'utf-8'));
      const meta = normalizeMetadata(raw, lock.metadata?.databasePath ?? '');
      if (meta?.ownerToken && meta.ownerToken !== lock.ownerToken) {
        // Another process owns the lock now — do not remove.
        return;
      }
      // Legacy locks without ownerToken: only remove if PID still matches us.
      if (!meta?.ownerToken && meta?.pid != null && meta.pid !== process.pid) {
        return;
      }
    }

    // Prefer renaming to a released archive rather than permanent delete so
    // field diagnostics retain the last owner snapshot. Then remove by
    // renaming out of the active lock path; leave archive on disk.
    const released = join(
      lock.lockDir,
      '..',
      `${LOCK_DIR_NAME}.released-${formatArchiveStamp()}-${process.pid}`,
    );
    try {
      renameSync(lock.lockDir, released);
    } catch {
      // If rename fails because someone else already moved it, that is fine.
    }
  } catch {
    // Best-effort release.
  }
}

/**
 * Read lock diagnostics without attempting to acquire.
 */
export async function inspectLock(
  dataDir: string,
  opts?: { inspector?: ProcessInspector },
): Promise<LockDiagnostics> {
  const lockDir = getLockDir(dataDir);
  const inspector = resolveInspector(opts?.inspector);
  if (!lockDir || !existsSync(lockDir)) {
    return {
      databasePath: redactPath(dataDir),
      lockPath: redactPath(lockFilePath(lockDir || join(dataDir, LOCK_DIR_NAME))),
      lockExists: false,
      lockMetadata: null,
      currentBootMarker: await inspector.getBootMarker(),
      lockBootMarkerMatches: null,
      pidExists: null,
      processStartMatches: null,
      executableMatches: null,
      decision: 'acquire_new',
      reason: 'lock_absent',
    };
  }
  const evaluation = await evaluateExistingLock(dataDir, lockDir, inspector);
  return evaluation.diagnostics;
}

/**
 * List archived stale lock directories next to a database path (diagnostics only).
 */
export function listArchivedLocks(dataDir: string): string[] {
  try {
    return readdirSync(dataDir)
      .filter((name) => name.startsWith(`${LOCK_DIR_NAME}.stale-`) || name.startsWith(`${LOCK_DIR_NAME}.released-`))
      .map((name) => join(dataDir, name));
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test helper: force-write a lock directory with given metadata (no live acquire). */
export function writeLockFixture(dataDir: string, metadata: Record<string, unknown>): string {
  mkdirSync(dataDir, { recursive: true });
  const lockDir = getLockDir(dataDir);
  if (existsSync(lockDir)) {
    throw new PgliteLockMetadataError(lockDir, 'lock already exists');
  }
  mkdirSync(lockDir, { recursive: false });
  writeFileSync(lockFilePath(lockDir), JSON.stringify(metadata, null, 2), { mode: 0o644 });
  return lockDir;
}

/** Test helper: check whether the active lock directory currently exists. */
export function lockDirExists(dataDir: string): boolean {
  return existsSync(getLockDir(dataDir));
}

/** Test helper: read raw lock JSON if present. */
export function readLockMetadata(dataDir: string): Partial<LockMetadataV2> | null {
  const path = lockFilePath(getLockDir(dataDir));
  if (!existsSync(path)) return null;
  return normalizeMetadata(safeJsonParse(readFileSync(path, 'utf-8')), dataDir);
}

/** True when a path entry is an active lock dir (not archive). */
export function isActiveLockPath(pathValue: string): boolean {
  try {
    return existsSync(pathValue) && statSync(pathValue).isDirectory() && pathValue.endsWith(LOCK_DIR_NAME);
  } catch {
    return false;
=======
  // Only the owner token written by this handle may remove the directory.
  // Missing or unreadable metadata is intentionally fail-closed: deleting an
  // unverifiable lock could let a second process open a live PGLite database.
  if (!lock.ownerToken) return;
  try {
    const raw = JSON.parse(readFileSync(join(lock.lockDir, LOCK_FILE), 'utf-8'));
    if (tokenOf(raw) !== lock.ownerToken) return;
  } catch {
    return;
  }

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
    lock.acquired = false;
  } catch {
    // The owner may already have cleaned it during orderly shutdown.
>>>>>>> 6a2c6ad171d97368c36050d97f69297926787ea9
  }
}
