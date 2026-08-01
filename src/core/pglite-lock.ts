/**
 * PGLite File Lock — prevents concurrent process access to the same data directory.
 *
 * PGLite uses embedded Postgres (WASM) which only supports one connection at a time.
 * When `gbrain embed` (which can take minutes) is running and another process tries
 * to connect, PGLite throws `Aborted()` because it can't handle concurrent access.
 *
 * This module implements a simple advisory lock using a lock file next to the data
 * directory. It uses atomic `mkdir` (which is POSIX-atomic) combined with PID tracking
 * for stale lock detection.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 */

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
  return join(dataDir, LOCK_DIR_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
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
/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts: AcquireLockOptions = {}): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  mkdirSync(dataDir as string, { recursive: true });

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
      }
    }

    try {
      mkdirSync(lockDir, { recursive: false });
    } catch {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) throw pgliteLockTimeoutError(lockDir);
      await new Promise(r => setTimeout(r, Math.min(500, timeoutMs - elapsed)));
      continue;
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

  throw pgliteLockTimeoutError(lockDir);
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (lock.heartbeat) {
    clearInterval(lock.heartbeat);
    lock.heartbeat = undefined;
  }
  if (!lock.lockDir || !lock.acquired) return;

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
  }
}
