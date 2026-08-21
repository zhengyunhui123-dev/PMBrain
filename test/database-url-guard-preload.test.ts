/**
 * Regression tests for the invocation-level database URL guard.
 *
 * Each case spawns a real `bun test` child against a trivial probe so this
 * verifies the actual Bun preload behavior rather than re-implementing it.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PROBE = 'test/fixtures/preload-guard/guard-probe.test.ts';
const GUARD_MARKER = 'TEST-RUN GUARD: refusing to start';

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'DATABASE_URL' || key === 'GBRAIN_DATABASE_URL' || key === 'PMBRAIN_DATABASE_URL' || key === 'GBRAIN_TEST_ALLOW_DATABASE_URL') continue;
    env[key] = value;
  }
  return env;
}

function runProbe(extra: Record<string, string>): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'test', '--timeout=15000', PROBE], {
    cwd: REPO_ROOT,
    env: { ...baseEnv(), ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

describe('database-url-guard-preload', () => {
  test('refuses an ambient DATABASE_URL', () => {
    const result = runProbe({ DATABASE_URL: 'postgresql://localhost:5434/gbrain' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MARKER);
    expect(result.stderr).toContain('DATABASE_URL');
  }, 30_000);

  test('refuses an ambient GBRAIN_DATABASE_URL', () => {
    const result = runProbe({ GBRAIN_DATABASE_URL: 'postgresql://localhost:5434/gbrain' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MARKER);
    expect(result.stderr).toContain('GBRAIN_DATABASE_URL');
  }, 30_000);

  test('refuses an ambient PMBRAIN_DATABASE_URL', () => {
    const result = runProbe({ PMBRAIN_DATABASE_URL: 'postgresql://localhost:5434/gbrain' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MARKER);
    expect(result.stderr).toContain('PMBRAIN_DATABASE_URL');
  }, 30_000);

  test('names all ambient variables when all are set', () => {
    const result = runProbe({
      DATABASE_URL: 'postgresql://localhost:5434/gbrain',
      GBRAIN_DATABASE_URL: 'postgresql://localhost:5434/gbrain',
      PMBRAIN_DATABASE_URL: 'postgresql://localhost:5434/gbrain',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MARKER);
    expect(result.stderr).toContain('DATABASE_URL and GBRAIN_DATABASE_URL and PMBRAIN_DATABASE_URL are set');
  }, 30_000);

  test('allows the explicit wrapper opt-in', () => {
    const result = runProbe({
      DATABASE_URL: 'postgresql://localhost:5434/gbrain_test',
      GBRAIN_TEST_ALLOW_DATABASE_URL: '1',
    });
    expect(result.stderr).not.toContain(GUARD_MARKER);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('runs clean with no ambient database URL', () => {
    const result = runProbe({});
    expect(result.stderr).not.toContain(GUARD_MARKER);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('refuses truthy but invalid override values', () => {
    const result = runProbe({
      DATABASE_URL: 'postgresql://localhost:5434/gbrain',
      GBRAIN_TEST_ALLOW_DATABASE_URL: 'true',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(GUARD_MARKER);
  }, 30_000);

  test('treats empty-string variables as unset', () => {
    const result = runProbe({ DATABASE_URL: '', GBRAIN_DATABASE_URL: '', PMBRAIN_DATABASE_URL: '' });
    expect(result.stderr).not.toContain(GUARD_MARKER);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
