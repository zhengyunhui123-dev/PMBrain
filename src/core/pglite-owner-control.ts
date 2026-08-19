/**
 * Safe operator controls for a PGLite owner that survived a failed handoff.
 *
 * This module deliberately separates inspection from termination. Inspection
 * is read-only; termination is allowed only for a live, foreign owner whose
 * lock metadata identifies it as a PMBrain CLI or Desktop sidecar. The active
 * lock is never deleted by this module.
 */
import { spawn } from 'node:child_process';
import {
  inspectLock,
  readLockMetadata,
  type LockDiagnostics,
  type LockMetadataV2,
} from './pglite-lock.ts';
import {
  createDefaultProcessInspector,
  looksLikePmbrainExecutable,
  type ProcessInspector,
} from './pglite-process-inspector.ts';

export type PgliteOwnerState = 'clear' | 'current' | 'active' | 'stale' | 'unavailable';

export interface PgliteOwnerStatus {
  state: PgliteOwnerState;
  pid: number | null;
  ownerType: string | null;
  commandLabel: string | null;
  acquiredAt: string | null;
  canTerminate: boolean;
  message: string;
}

export interface PgliteOwnerInspectOptions {
  inspector?: ProcessInspector;
  currentPid?: number;
  /** Set false while the current sidecar has an expected exclusive child run. */
  allowTerminate?: boolean;
}

export interface PgliteOwnerTerminateOptions extends PgliteOwnerInspectOptions {
  terminateProcess?: (pid: number) => Promise<void>;
  waitTimeoutMs?: number;
  pollMs?: number;
}

function asPid(value: unknown): number | null {
  const pid = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readMetadataSafely(dataDir: string): Partial<LockMetadataV2> | null {
  try {
    return readLockMetadata(dataDir);
  } catch {
    return null;
  }
}

function commandLabel(metadata: Partial<LockMetadataV2> | null): string | null {
  const command = metadata?.command ?? '';
  if (/src[\\/]cli\.ts\s+serve/i.test(command)) return '源码 PMBrain sidecar';
  if (/pmbrain-sidecar\.js\s+serve/i.test(command)) return 'PMBrain Desktop sidecar';
  if (metadata?.ownerType === 'desktop-sidecar') return 'PMBrain Desktop sidecar';
  if (metadata?.ownerType === 'cli') return 'PMBrain CLI';
  if (command.trim()) return 'PMBrain 进程';
  return null;
}

export function isControllablePgliteOwner(metadata: Partial<LockMetadataV2> | null): boolean {
  if (!metadata || (metadata.ownerType !== 'desktop-sidecar' && metadata.ownerType !== 'cli')) {
    return false;
  }
  return looksLikePmbrainExecutable(metadata.executablePath, metadata.command);
}

export function classifyPgliteOwner(
  diagnostics: LockDiagnostics,
  metadata: Partial<LockMetadataV2> | null,
  options: { currentPid?: number; allowTerminate?: boolean } = {},
): PgliteOwnerStatus {
  const currentPid = options.currentPid ?? process.pid;
  const pid = asPid(metadata?.pid ?? diagnostics.lockMetadata?.pid);
  const ownerType = typeof (metadata?.ownerType ?? diagnostics.lockMetadata?.ownerType) === 'string'
    ? String(metadata?.ownerType ?? diagnostics.lockMetadata?.ownerType)
    : null;
  const acquiredAt = typeof (metadata?.createdAt ?? diagnostics.lockMetadata?.createdAt) === 'string'
    ? String(metadata?.createdAt ?? diagnostics.lockMetadata?.createdAt)
    : null;
  const label = commandLabel(metadata ?? diagnostics.lockMetadata as Partial<LockMetadataV2> | null);
  const active = diagnostics.decision === 'reject_active_owner';
  const controllable = isControllablePgliteOwner(metadata);

  if (!diagnostics.lockExists || diagnostics.decision === 'acquire_new') {
    return {
      state: 'clear',
      pid: null,
      ownerType: null,
      commandLabel: null,
      acquiredAt: null,
      canTerminate: false,
      message: '没有发现其他进程占用 PGLite 数据库。',
    };
  }

  if (active && pid === currentPid) {
    return {
      state: 'current',
      pid,
      ownerType,
      commandLabel: label,
      acquiredAt,
      canTerminate: false,
      message: '当前 PMBrain 服务正在正常持有 PGLite 数据库。',
    };
  }

  if (active && pid !== null) {
    const canTerminate = options.allowTerminate !== false && controllable && pid !== currentPid;
    return {
      state: 'active',
      pid,
      ownerType,
      commandLabel: label,
      acquiredAt,
      canTerminate,
      message: canTerminate
        ? `发现另一个 PMBrain 进程（PID ${pid}）仍在占用数据库。这通常是维护中止后的残留进程，不是数据库损坏。`
        : `发现其他进程（PID ${pid}）仍在占用数据库，但当前无法安全结束它。请先确认进程来源。`,
    };
  }

  if (diagnostics.decision === 'archive_stale_lock') {
    return {
      state: 'stale',
      pid,
      ownerType,
      commandLabel: label,
      acquiredAt,
      canTerminate: false,
      message: '锁文件对应的进程已经退出；下一次 PGLite 重连会自动归档这份残留锁，不代表数据库损坏。',
    };
  }

  return {
    state: 'unavailable',
    pid,
    ownerType,
    commandLabel: label,
    acquiredAt,
    canTerminate: false,
    message: '暂时无法确认 PGLite 锁的所有者，已安全保留现有数据库和锁文件。',
  };
}

export async function inspectPgliteOwner(
  dataDir: string,
  options: PgliteOwnerInspectOptions = {},
): Promise<PgliteOwnerStatus> {
  const inspector = options.inspector ?? createDefaultProcessInspector();
  try {
    const diagnostics = await inspectLock(dataDir, { inspector });
    return classifyPgliteOwner(diagnostics, readMetadataSafely(dataDir), options);
  } catch {
    return {
      state: 'unavailable',
      pid: null,
      ownerType: null,
      commandLabel: null,
      acquiredAt: null,
      canTerminate: false,
      message: '暂时无法读取 PGLite 锁状态，已安全保留现有数据库。',
    };
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      // A non-zero taskkill exit can mean the process ended between the
      // identity check and taskkill. The post-kill inspection is authoritative.
      child.once('close', () => resolve());
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

async function waitForOwnerToStop(
  dataDir: string,
  expectedPid: number,
  options: PgliteOwnerTerminateOptions,
): Promise<PgliteOwnerStatus> {
  const timeoutMs = options.waitTimeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last = await inspectPgliteOwner(dataDir, options);
  while (Date.now() < deadline) {
    if (!(last.state === 'active' && last.pid === expectedPid)) return last;
    await new Promise(resolve => setTimeout(resolve, pollMs));
    last = await inspectPgliteOwner(dataDir, options);
  }
  return last;
}

export async function terminatePgliteOwner(
  dataDir: string,
  expectedPid: number,
  options: PgliteOwnerTerminateOptions = {},
): Promise<PgliteOwnerStatus> {
  const currentPid = options.currentPid ?? process.pid;
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) {
    throw new Error('PGLite 占用进程 PID 无效。');
  }
  if (expectedPid === currentPid) {
    throw new Error('不能结束当前 PMBrain 服务自身。');
  }

  const before = await inspectPgliteOwner(dataDir, { ...options, allowTerminate: true });
  if (before.state !== 'active' || before.pid !== expectedPid || !before.canTerminate) {
    throw new Error('PGLite 占用进程状态已变化，未执行结束操作。请刷新任务中心后重试。');
  }

  const metadata = readMetadataSafely(dataDir);
  if (!isControllablePgliteOwner(metadata)) {
    throw new Error('未能确认该 PID 属于 PMBrain，未执行结束操作。');
  }

  await (options.terminateProcess ?? terminateProcessTree)(expectedPid);
  const after = await waitForOwnerToStop(dataDir, expectedPid, {
    ...options,
    currentPid,
    allowTerminate: false,
  });
  if (after.state === 'active' && after.pid === expectedPid) {
    throw new Error(`PID ${expectedPid} 仍未退出，未修改数据库或锁文件。`);
  }
  return after;
}
