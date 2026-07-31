import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runProbePglite } from '../src/commands/probe-pglite.ts';
import { lockDirExists, setDefaultProcessInspector } from '../src/core/pglite-lock.ts';
import { FakeProcessInspector } from '../src/core/pglite-process-inspector.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ROOT = join(tmpdir(), `probe-pglite-${process.pid}-${Date.now()}`);

describe('probe-pglite', () => {
  beforeEach(() => {
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    const inspector = new FakeProcessInspector({ bootMarker: 'boot-probe' });
    inspector.setProcess(process.pid, {
      exists: true,
      startTime: 'probe-start',
      executablePath: process.execPath,
    });
    setDefaultProcessInspector(inspector);
  });

  afterEach(() => {
    setDefaultProcessInspector(null);
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  test('21. probe-pglite succeeds then disconnects and releases lock', async () => {
    const dbDir = join(ROOT, 'brain.pglite');
    // Seed a minimal real PGLite DB via engine so probe has something valid.
    const seed = new PGLiteEngine();
    await seed.connect({ engine: 'pglite', database_path: dbDir });
    await seed.db.query('SELECT 1');
    await seed.disconnect();
    expect(lockDirExists(dbDir)).toBe(false);

    const result = await runProbePglite(['--path', dbDir, '--json']);
    expect(result.ok).toBe(true);
    expect(result.select1).toBe(true);
    expect(result.disconnected).toBe(true);
    expect(result.lockReleased).toBe(true);
    expect(lockDirExists(dbDir)).toBe(false);
  });

  test('probe-pglite fails clearly when database cannot open', async () => {
    const bad = join(ROOT, 'not-a-db');
    mkdirSync(bad, { recursive: true });
    // Create a file that is not a valid PGLite data dir structure may still open empty —
    // write a blocking active lock with live owner to force failure.
    const { writeLockFixture } = await import('../src/core/pglite-lock.ts');
    const inspector = new FakeProcessInspector({ bootMarker: 'boot-probe' });
    inspector.setProcess(process.pid, {
      exists: true,
      startTime: 'probe-start',
      executablePath: process.execPath,
    });
    inspector.setProcess(700001, {
      exists: true,
      startTime: 'live',
      executablePath: 'D:\\PMBrain\\pmbrain-sidecar.exe',
    });
    setDefaultProcessInspector(inspector);
    writeLockFixture(bad, {
      schemaVersion: 2,
      pid: 700001,
      processStartTime: 'live',
      bootMarker: 'boot-probe',
      ownerToken: 'other',
      ownerType: 'desktop-sidecar',
      databasePath: bad,
      executablePath: 'D:\\PMBrain\\pmbrain-sidecar.exe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await runProbePglite(['--path', bad, '--json']);
    expect(result.ok).toBe(false);
    expect(result.errorName === 'DatabaseAlreadyOwnedError' || /owned|lock/i.test(result.error ?? '')).toBe(true);
  });
});
