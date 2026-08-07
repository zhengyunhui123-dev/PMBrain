/**
 * ProcessInspector — injectable process/boot identity for PGLite lock ownership.
 *
 * Unit tests inject a FakeProcessInspector. Production uses createDefaultProcessInspector().
 *
 * Reliability notes for bootMarker / processStartTime on Windows:
 * - bootMarker prefers OS last-boot timestamp (WMI LastBootUpTime / /proc/stat btime).
 *   If unavailable, falls back to a coarse marker derived from Date.now() - os.uptime()*1000.
 *   The fallback is sufficient to detect a reboot (uptime resets) but is not a cryptographic
 *   boot ID and can drift by a few seconds across processes started at different wall times.
 * - processStartTime uses WMI CreationDate or /proc/<pid> starttime when available.
 *   If unavailable, returns null; lock validation then relies on pid existence + executable path.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { uptime as osUptime } from 'node:os';

const execFileAsync = promisify(execFile);

export interface ProcessInspector {
  exists(pid: number): Promise<boolean>;
  getStartTime(pid: number): Promise<string | null>;
  getExecutablePath(pid: number): Promise<string | null>;
  getBootMarker(): Promise<string>;
}

export interface FakeProcessState {
  exists?: boolean;
  startTime?: string | null;
  executablePath?: string | null;
}

export class FakeProcessInspector implements ProcessInspector {
  private readonly processes = new Map<number, FakeProcessState>();
  private bootMarker: string;

  constructor(opts?: { bootMarker?: string }) {
    this.bootMarker = opts?.bootMarker ?? 'boot-test-1';
  }

  setBootMarker(marker: string): void {
    this.bootMarker = marker;
  }

  setProcess(pid: number, state: FakeProcessState): void {
    this.processes.set(pid, state);
  }

  clearProcess(pid: number): void {
    this.processes.delete(pid);
  }

  async exists(pid: number): Promise<boolean> {
    const state = this.processes.get(pid);
    if (!state) return false;
    return state.exists !== false;
  }

  async getStartTime(pid: number): Promise<string | null> {
    const state = this.processes.get(pid);
    if (!state || state.exists === false) return null;
    return state.startTime ?? null;
  }

  async getExecutablePath(pid: number): Promise<string | null> {
    const state = this.processes.get(pid);
    if (!state || state.exists === false) return null;
    return state.executablePath ?? null;
  }

  async getBootMarker(): Promise<string> {
    return this.bootMarker;
  }
}

export function createDefaultProcessInspector(): ProcessInspector {
  return new DefaultProcessInspector();
}

class DefaultProcessInspector implements ProcessInspector {
  private bootMarkerCache: string | null = null;

  async exists(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EPERM means the process exists but we cannot signal it.
      if (code === 'EPERM') return true;
      return false;
    }
  }

  async getStartTime(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'win32') {
      return readWindowsStartTime(pid);
    }
    return readUnixStartTime(pid);
  }

  async getExecutablePath(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) {
      return process.execPath;
    }
    if (process.platform === 'win32') {
      return readWindowsExecutablePath(pid);
    }
    return readUnixExecutablePath(pid);
  }

  async getBootMarker(): Promise<string> {
    if (this.bootMarkerCache) return this.bootMarkerCache;
    const marker = process.platform === 'win32'
      ? await readWindowsBootMarker()
      : readUnixBootMarker();
    this.bootMarkerCache = marker;
    return marker;
  }
}

function fallbackBootMarker(): string {
  // Coarse wall-clock estimate of last boot. Good enough to invalidate locks
  // across reboots when WMI /proc is unavailable; not unique across machines.
  const bootMs = Date.now() - Math.floor(osUptime() * 1000);
  const rounded = Math.floor(bootMs / 60_000) * 60_000;
  return `uptime:${rounded}@${hostname()}`;
}

async function readWindowsBootMarker(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
      ],
      { timeout: 5_000, windowsHide: true },
    );
    const value = stdout.trim();
    if (value) return `winboot:${value}`;
  } catch {
    /* fall through */
  }
  return fallbackBootMarker();
}

async function readWindowsStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { timeout: 5_000, windowsHide: true },
    );
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function readWindowsExecutablePath(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
      ],
      { timeout: 5_000, windowsHide: true },
    );
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function readUnixBootMarker(): string {
  try {
    if (existsSync('/proc/stat')) {
      const text = readFileSync('/proc/stat', 'utf8');
      const match = text.match(/^btime\s+(\d+)/m);
      if (match) return `btime:${match[1]}`;
    }
  } catch {
    /* fall through */
  }
  return fallbackBootMarker();
}

function readUnixStartTime(pid: number): string | null {
  try {
    // Field 22 in /proc/<pid>/stat is starttime (clock ticks after boot).
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const rest = stat.slice(closeParen + 2).split(/\s+/);
    const startTicks = rest[19];
    if (!startTicks) return null;
    return `ticks:${startTicks}`;
  } catch {
    return null;
  }
}

function readUnixExecutablePath(pid: number): string | null {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const parts = cmdline.split('\0').filter(Boolean);
      return parts[0] ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Heuristic: does this executable path look like a PMBrain/GBrain owner
 * (sidecar, bun/node running cli, packaged runtime)?
 */
export function looksLikePmbrainExecutable(executablePath: string | null | undefined, commandHint?: string | null): boolean {
  const haystack = `${executablePath ?? ''} ${commandHint ?? ''}`.toLowerCase().replace(/\\/g, '/');
  if (!haystack.trim()) return false;
  return (
    haystack.includes('pmbrain')
    || haystack.includes('gbrain')
    || haystack.includes('pmbrain-sidecar')
    || /[/\\](bun|node|node\.exe|bun\.exe)(\s|"|$)/i.test(haystack)
  );
}
