/**
 * Upgrade / single-owner regression scenarios for desktop PGLite.
 * Uses FakeProcessInspector — no real Windows PID dependency.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireLock,
  releaseLock,
  writeLockFixture,
  lockDirExists,
  listArchivedLocks,
  setDefaultProcessInspector,
} from '../src/core/pglite-lock.ts';
import { FakeProcessInspector } from '../src/core/pglite-process-inspector.ts';
import { DatabaseAlreadyOwnedError, classifySidecarStartupError } from '../src/core/pglite-errors.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = join(tmpdir(), `pglite-upgrade-${process.pid}-${Date.now()}`);

describe('PGLite upgrade scenarios A–E', () => {
  let inspector: FakeProcessInspector;
  let dbDir: string;

  beforeEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    dbDir = join(ROOT, 'brain.pglite');
    mkdirSync(dbDir, { recursive: true });
    inspector = new FakeProcessInspector({ bootMarker: 'boot-new' });
    inspector.setProcess(process.pid, {
      exists: true,
      startTime: 'self-start',
      executablePath: process.execPath,
    });
    setDefaultProcessInspector(inspector);
  });

  afterEach(() => {
    setDefaultProcessInspector(null);
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  test('Scenario A: stale lock from previous boot is archived; unique owner opens DB; SELECT 1', async () => {
    // Simulate old-version lock left after abnormal exit on previous Windows boot.
    writeLockFixture(dbDir, {
      schemaVersion: 1,
      pid: 111222,
      acquired_at: Date.now() - 86_400_000,
      command: 'pmbrain serve --http',
      bootMarker: 'boot-old',
      ownerToken: 'legacy',
      processStartTime: 'old',
      ownerType: 'desktop-sidecar',
      databasePath: dbDir,
      executablePath: 'C:\\old\\pmbrain.exe',
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    inspector.setProcess(111222, {
      exists: true,
      startTime: 'reused',
      executablePath: 'C:\\Windows\\explorer.exe',
    });

    const lock = await acquireLock(dbDir, { inspector, ownerType: 'desktop-sidecar', failFastIfOwned: true });
    expect(lock.acquired).toBe(true);
    expect(listArchivedLocks(dbDir).length).toBeGreaterThan(0);

    // Hand off: release lock before PGLiteEngine acquires its own (single owner at a time).
    await releaseLock(lock);

    await withEnv({ PMBRAIN_PGLITE_OWNER_TYPE: 'desktop-sidecar' }, async () => {
      const engine = new PGLiteEngine();
      try {
        await engine.connect({ engine: 'pglite', database_path: dbDir });
        const rows = await engine.db.query<{ ok: number }>('SELECT 1 AS ok');
        expect(rows.rows[0]?.ok).toBe(1);
      } finally {
        await engine.disconnect();
      }
    });
  }, 30_000);

  test('Scenario B: live owner rejects second instance without deleting live lock', async () => {
    writeLockFixture(dbDir, {
      schemaVersion: 2,
      pid: 900001,
      processStartTime: 'live',
      bootMarker: 'boot-new',
      ownerToken: 'live-owner',
      ownerType: 'desktop-sidecar',
      databasePath: dbDir,
      executablePath: 'D:\\PMBrain\\pmbrain-sidecar.exe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(900001, {
      exists: true,
      startTime: 'live',
      executablePath: 'D:\\PMBrain\\pmbrain-sidecar.exe',
    });

    await expect(
      acquireLock(dbDir, { inspector, failFastIfOwned: true, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(DatabaseAlreadyOwnedError);
    expect(lockDirExists(dbDir)).toBe(true);
    expect(listArchivedLocks(dbDir).length).toBe(0);
  });

  test('Scenario C: PID match but unrelated program is treated as reuse residue', async () => {
    writeLockFixture(dbDir, {
      schemaVersion: 2,
      pid: 900002,
      processStartTime: null,
      bootMarker: 'boot-new',
      ownerToken: 'stale',
      ownerType: 'desktop-sidecar',
      databasePath: dbDir,
      executablePath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(900002, {
      exists: true,
      startTime: null,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    const lock = await acquireLock(dbDir, { inspector, failFastIfOwned: true });
    expect(lock.acquired).toBe(true);
    expect(listArchivedLocks(dbDir).some((p) => p.includes('executable_not_pmbrain'))).toBe(true);
    await releaseLock(lock);
  });

  test('Scenario D: classify open failure as non-retryable database_open_failed', () => {
    const c = classifySidecarStartupError(
      new Error('PGlite.create failed: Aborted() filesystem error'),
    );
    expect(c.category).toBe('database_open_failed');
    expect(c.retryable).toBe(false);
    expect(c.labelZh).toContain('数据库');
  });

  test('Scenario E: healthy open + SELECT 1 after clean lock', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dbDir });
      const rows = await engine.db.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows.rows[0]?.ok).toBe(1);
    } finally {
      await engine.disconnect();
    }
    expect(lockDirExists(dbDir)).toBe(false);
  }, 30_000);
});

describe('desktop migration single-owner contract', () => {
  test('13. desktop main defers PGLite migration to sidecar (no overlapping CLI owner)', () => {
    const database = readFileSync(join(import.meta.dir, '../desktop/src/main/database/database-upgrade.ts'), 'utf8');
    expect(database).toContain("setup.current.engine === 'pglite'");
    expect(database).toContain('PGLite migrations delegated to sidecar');
    expect(database).toContain('pgliteBackup.ensureUpgradeBackup');
  });

  test('20. diagnostic-mode skips Dream schedule and supervisor', () => {
    const serve = readFileSync(join(import.meta.dir, '../src/commands/serve.ts'), 'utf8');
    const serveHttp = readFileSync(join(import.meta.dir, '../src/commands/serve-http.ts'), 'utf8');
    expect(serve).toContain('--diagnostic-mode');
    expect(serveHttp).toContain('diagnosticMode');
    expect(serveHttp).toContain('diagnostic_mode_disables_supervisor');
    expect(serveHttp).toContain('Dream schedule timer not started');
  });

  test('sidecar sets fail-fast lock and desktop-sidecar owner type', () => {
    const sidecar = readFileSync(join(import.meta.dir, '../desktop/src/main/sidecar-manager.ts'), 'utf8');
    expect(sidecar).toContain("PMBRAIN_PGLITE_OWNER_TYPE: 'desktop-sidecar'");
    expect(sidecar).toContain("PMBRAIN_PGLITE_LOCK_FAIL_FAST: '1'");
    expect(sidecar).toContain('classifySidecarStartupError');
    expect(sidecar).toContain('SidecarExitedBeforeHealthyError');
  });

  test('maintenance children use a CLI owner and HTTP bind failures release the lock', () => {
    const executor = readFileSync(join(import.meta.dir, '../src/commands/natural-lang/executor.ts'), 'utf8');
    const cli = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf8');
    expect(executor).toContain("PMBRAIN_PGLITE_OWNER_TYPE: 'cli'");
    expect(executor).toContain("PMBRAIN_PGLITE_LOCK_FAIL_FAST: '0'");
    expect(cli).toContain('HTTP startup can fail after connectEngine()');
    expect(cli).toContain('await engine.disconnect().catch(() => undefined);');
  });

  test('25. config-manager still resolves ~/.gbrain style preferred directory helpers', () => {
    const cfg = readFileSync(join(import.meta.dir, '../desktop/src/main/config-manager.ts'), 'utf8');
    expect(cfg).toMatch(/preferredConfigDirectory|gbrain|pmbrain/);
    expect(cfg).toContain('brain.pglite');
  });
});
