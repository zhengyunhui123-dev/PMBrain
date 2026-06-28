import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { ConsoleRun } from './types.ts';

// In-memory stores (module-level singletons, shared across all importers)
export const previews = new Map<string, import('./types.ts').IntentPreview>();
export const runs = new Map<string, ConsoleRun>();

export function sanitizeOutput(text: string): string {
  return text
    .replace(/(postgresql:\/\/[^:\s]+:)([^@\s]+)(@)/g, '$1***$3')
    .replace(/\b(gbrain_[A-Za-z0-9_-]{16,})\b/g, 'gbrain_***')
    .replace(/((?:api[_-]?key|token|secret|password|pwd)["']?\s*[:=]\s*["']?)([^"',\s]+)/gi, '$1***');
}

export function getRun(id: string): ConsoleRun | null {
  return runs.get(id) ?? null;
}

export function listRuns(): ConsoleRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
}

export interface RunHooks {
  beforeSpawn?: () => Promise<void>;
  afterComplete?: () => Promise<void>;
}

export async function startRun(kind: string, command: string[], cwd: string, hooks?: RunHooks): Promise<ConsoleRun> {
  const id = randomUUID();
  const started = Date.now();
  const run: ConsoleRun = {
    id,
    kind,
    status: 'running',
    command,
    stdout: '',
    stderr: '',
    exitCode: null,
    error: null,
    startedAt: new Date(started).toISOString(),
    completedAt: null,
    durationMs: null,
  };
  runs.set(id, run);

  // PGLite lock coordination: release the engine lock before spawning a child
  // process so the child can acquire it; reconnect after the child completes.
  if (hooks?.beforeSpawn) {
    try {
      await hooks.beforeSpawn();
    } catch (e) {
      run.status = 'failed';
      run.error = sanitizeOutput(e instanceof Error ? e.message : String(e));
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - started;
      return run;
    }
  }

  const child = spawn(command[0], command.slice(1), {
    cwd,
    shell: false,
    windowsHide: true,
    env: process.env,
  });
  const cap = 120_000;
  const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
    run[key] = sanitizeOutput((run[key] + chunk.toString('utf8')).slice(-cap));
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.on('error', (err) => {
    run.status = 'failed';
    run.error = sanitizeOutput(err.message);
    run.completedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
  });
  child.on('close', (code) => {
    run.exitCode = code;
    run.status = code === 0 ? 'completed' : 'failed';
    run.completedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
    if (hooks?.afterComplete) {
      hooks.afterComplete().catch(() => undefined);
    }
  });
  setTimeout(() => {
    if (run.status === 'running') {
      run.status = 'failed';
      run.error = 'Command timed out after 10 minutes';
      child.kill();
    }
  }, 10 * 60 * 1000).unref?.();

  return run;
}
