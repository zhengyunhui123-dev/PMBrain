/**
 * probe-pglite — open the configured (or given) PGLite directory once,
 * run SELECT 1, read config.version if present, disconnect and release the lock.
 *
 * Does NOT start HTTP, Dream, Worker, or Supervisor.
 */

import { loadConfig } from '../core/config.ts';
import { PGLiteEngine } from '../core/pglite-engine.ts';
import { inspectLock, listArchivedLocks } from '../core/pglite-lock.ts';
import { PgliteProbeError } from '../core/pglite-errors.ts';
import { createDefaultProcessInspector } from '../core/pglite-process-inspector.ts';

export interface ProbePgliteResult {
  ok: boolean;
  databasePath: string | null;
  select1: boolean;
  configVersion: string | null;
  lockDiagnostics: Awaited<ReturnType<typeof inspectLock>> | null;
  archivedLocks: string[];
  disconnected: boolean;
  lockReleased: boolean;
  error?: string;
  errorName?: string;
}

function parseArgs(args: string[]): { databasePath?: string; json: boolean } {
  let databasePath: string | undefined;
  let json = args.includes('--json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      databasePath = args[++i];
    } else if (args[i] === '--database-path' && args[i + 1]) {
      databasePath = args[++i];
    }
  }
  return { databasePath, json };
}

export async function runProbePglite(args: string[] = []): Promise<ProbePgliteResult> {
  const { databasePath: argPath, json } = parseArgs(args);
  const config = loadConfig();
  const databasePath = argPath
    ?? config?.database_path
    ?? null;

  const result: ProbePgliteResult = {
    ok: false,
    databasePath,
    select1: false,
    configVersion: null,
    lockDiagnostics: null,
    archivedLocks: [],
    disconnected: false,
    lockReleased: false,
  };

  if (!databasePath) {
    result.error = 'No PGLite database path configured. Pass --path <dir> or run pmbrain init.';
    result.errorName = 'PgliteProbeError';
    emit(result, json);
    return result;
  }

  if (config?.engine === 'postgres' && !argPath) {
    result.error = 'Configured engine is postgres. Pass --path to probe a PGLite directory explicitly.';
    result.errorName = 'PgliteProbeError';
    emit(result, json);
    return result;
  }

  process.env.PMBRAIN_PGLITE_OWNER_TYPE = 'probe';
  process.env.PMBRAIN_PGLITE_LOCK_FAIL_FAST = '1';

  const inspector = createDefaultProcessInspector();
  result.lockDiagnostics = await inspectLock(databasePath, { inspector });
  result.archivedLocks = listArchivedLocks(databasePath).map((p) => p.replace(/\\/g, '/'));

  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    const rows = await engine.db.query<{ ok: number }>('SELECT 1 AS ok');
    result.select1 = rows.rows[0]?.ok === 1;

    try {
      const versionRows = await engine.db.query<{ value: string }>(
        `SELECT value FROM config WHERE key = 'version' LIMIT 1`,
      );
      result.configVersion = versionRows.rows[0]?.value ?? null;
    } catch {
      result.configVersion = null;
    }

    result.ok = result.select1;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.errorName = err instanceof Error ? err.name : 'Error';
    if (!(err instanceof PgliteProbeError) && err instanceof Error) {
      // keep original typed errors (DatabaseAlreadyOwnedError, PgliteOpenError, ...)
    }
  } finally {
    try {
      await engine.disconnect();
      result.disconnected = true;
      result.lockReleased = true;
    } catch (disconnectErr) {
      result.disconnected = false;
      result.lockReleased = false;
      if (!result.error) {
        result.error = disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr);
      }
    }
  }

  emit(result, json);
  return result;
}

function emit(result: ProbePgliteResult, json: boolean): void {
  if (json || process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.ok) {
    console.log(`probe-pglite: OK path=${result.databasePath} select1=true version=${result.configVersion ?? 'n/a'}`);
  } else {
    console.error(`probe-pglite: FAILED path=${result.databasePath}`);
    if (result.error) console.error(`  error: ${result.error}`);
    if (result.lockDiagnostics) {
      console.error(`  lock decision: ${result.lockDiagnostics.decision} (${result.lockDiagnostics.reason})`);
    }
  }
}
