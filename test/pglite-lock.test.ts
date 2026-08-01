import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid);

describe('pglite-lock', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    // Second lock attempt should timeout
    await expect(acquireLock(TEST_DIR, { timeoutMs: 1000 })).rejects.toThrow(/Timed out/);

    await releaseLock(lock1);
  });

  test('permission-denied liveness checks are treated as a live owner and never reaped', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 424242,
      acquired_at: Date.now(),
      command: 'protected owner',
      role: 'cli',
      owner_token: 'protected-owner-token',
    }));

    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof process.kill;
    try {
      await expect(acquireLock(TEST_DIR, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
      expect(JSON.parse(readFileSync(join(lockDir, 'lock'), 'utf-8')).owner_token).toBe(
        'protected-owner-token',
      );
    } finally {
      process.kill = originalKill;
    }
  });
  test('detects and cleans stale lock from dead process', async () => {
    // Simulate a stale lock from a dead process
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      command: 'test',
    }));

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('never removes an old lock while its owning process is still alive', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: process.pid,
      acquired_at: Date.now() - 60 * 60 * 1000,
      command: 'long-running-pmbrain-sidecar',
    }));

    await expect(acquireLock(TEST_DIR, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir, 'lock'), 'utf-8')).pid).toBe(process.pid);
  });

  test('skips lock for in-memory (undefined dataDir)', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    // Release should be a no-op
    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR, { role: 'migration' });
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.refreshed_at).toBeDefined();
    expect(lockData.command).toBeDefined();
    expect(lockData.role).toBe('migration');
    expect(typeof lockData.owner_token).toBe('string');
    expect(lockData.owner_token.length).toBeGreaterThan(10);
    expect(lock.ownerToken).toBe(lockData.owner_token);
    expect(lock.heartbeat).toBeDefined();

    await releaseLock(lock);
    expect(lock.heartbeat).toBeUndefined();
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });


  test('never steals a live lock even when its heartbeat is stale', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: process.pid,
      acquired_at: Date.now() - 60 * 60 * 1000,
      refreshed_at: Date.now() - 30 * 60 * 1000,
      command: 'pmbrain embed --stale',
      role: 'cli',
      owner_token: 'live-owner-token',
    }));

    await expect(acquireLock(TEST_DIR, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    const lockData = JSON.parse(readFileSync(join(lockDir, 'lock'), 'utf-8'));
    expect(lockData.owner_token).toBe('live-owner-token');
  });

  test('a stale handle cannot delete a replacement owner lock', async () => {
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.ownerToken).toBeDefined();
    if (lock.heartbeat) clearInterval(lock.heartbeat);

    const lockFile = join(TEST_DIR, '.gbrain-lock', 'lock');
    writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      acquired_at: Date.now() + 1,
      refreshed_at: Date.now() + 1,
      command: 'replacement owner',
      role: 'desktop-sidecar',
      owner_token: 'replacement-owner-token',
    }));

    await releaseLock(lock);

    expect(existsSync(lockFile)).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, 'utf-8')).owner_token).toBe('replacement-owner-token');
  });

  test('corrupt lock metadata is blocked instead of being deleted automatically', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), '{not valid json');

    await expect(acquireLock(TEST_DIR, { timeoutMs: 100 })).rejects.toThrow(/lock metadata is unreadable/i);
    expect(existsSync(lockDir)).toBe(true);
  });

  test('a live desktop sidecar owner fails fast with a clear local-service hint', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: process.pid,
      acquired_at: Date.now(),
      refreshed_at: Date.now(),
      command: 'pmbrain-sidecar.js serve --http',
      subcommand: 'serve',
      role: 'desktop-sidecar',
      owner_token: 'desktop-owner-token',
    }));

    const startedAt = Date.now();
    await expect(acquireLock(TEST_DIR, { timeoutMs: 5_000 })).rejects.toThrow(
      /desktop sidecar|local service/i,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(existsSync(lockDir)).toBe(true);
  });
});
