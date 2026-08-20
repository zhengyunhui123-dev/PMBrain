import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LockDiagnostics, LockMetadataV2 } from '../src/core/pglite-lock.ts';
import { writeLockFixture } from '../src/core/pglite-lock.ts';
import { FakeProcessInspector } from '../src/core/pglite-process-inspector.ts';
import { classifyPgliteOwner, isControllablePgliteOwner, terminatePgliteOwner } from '../src/core/pglite-owner-control.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function diagnostics(overrides: Partial<LockDiagnostics> = {}): LockDiagnostics {
  return {
    databasePath: 'C:/brain.pglite',
    lockPath: 'C:/brain.pglite/.gbrain-lock/lock',
    lockExists: true,
    lockMetadata: {
      pid: 11304,
      ownerType: 'desktop-sidecar',
      createdAt: '2026-08-19T02:17:58.408Z',
    },
    currentBootMarker: 'boot-current',
    lockBootMarkerMatches: true,
    pidExists: true,
    processStartMatches: true,
    executableMatches: true,
    decision: 'reject_active_owner',
    reason: 'owner_still_active',
    ...overrides,
  };
}

function metadata(overrides: Partial<LockMetadataV2> = {}): LockMetadataV2 {
  return {
    schemaVersion: 2,
    pid: 11304,
    processStartTime: '2026-08-19T02:17:36.930Z',
    bootMarker: 'boot-current',
    ownerToken: 'redacted-test-token',
    ownerType: 'desktop-sidecar',
    databasePath: 'C:/brain.pglite',
    executablePath: 'C:/Program Files/PMBrain/bun.exe',
    command: 'D:/cursor-claude/PMBrain/src/cli.ts serve --http',
    createdAt: '2026-08-19T02:17:58.408Z',
    updatedAt: '2026-08-19T02:17:58.408Z',
    ...overrides,
  };
}

describe('PGLite owner recovery status', () => {
  test('active foreign PMBrain owner is exposed as recoverable, not database corruption', () => {
    const status = classifyPgliteOwner(diagnostics(), metadata(), { currentPid: 29316 });
    expect(status.state).toBe('active');
    expect(status.pid).toBe(11304);
    expect(status.canTerminate).toBe(true);
    expect(status.commandLabel).toBe('源码 PMBrain sidecar');
    expect(status.message).toContain('不是数据库损坏');
  });

  test('the current sidecar owner never gets a terminate action', () => {
    const status = classifyPgliteOwner(diagnostics({ lockMetadata: { pid: 29316 } }), metadata({ pid: 29316 }), { currentPid: 29316 });
    expect(status.state).toBe('current');
    expect(status.canTerminate).toBe(false);
  });

  test('a dead owner becomes stale and cannot be killed', () => {
    const status = classifyPgliteOwner(
      diagnostics({ decision: 'archive_stale_lock', reason: 'pid_not_running', pidExists: false }),
      metadata(),
      { currentPid: 29316 },
    );
    expect(status.state).toBe('stale');
    expect(status.canTerminate).toBe(false);
    expect(status.message).toContain('已经退出');
  });

  test('unknown or non-PMBrain owners are not controllable', () => {
    expect(isControllablePgliteOwner(metadata({ ownerType: 'unknown', command: 'other-app serve' }))).toBe(false);
    expect(isControllablePgliteOwner(metadata({ ownerType: 'migration', command: 'pmbrain migration' }))).toBe(false);
  });

  test('termination rechecks owner identity and leaves the lock for reconnect cleanup', async () => {
    const dbDir = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'pmbrain-owner-control-'));
    roots.push(dbDir);
    const inspector = new FakeProcessInspector({ bootMarker: 'boot-current' });
    inspector.setProcess(11304, {
      startTime: '2026-08-19T02:17:36.930Z',
      executablePath: 'C:/Program Files/PMBrain/bun.exe',
    });
    writeLockFixture(dbDir, { ...metadata() });
    let terminatedPid: number | null = null;
    const result = await terminatePgliteOwner(dbDir, 11304, {
      currentPid: 29316,
      inspector,
      waitTimeoutMs: 100,
      pollMs: 1,
      terminateProcess: async pid => {
        terminatedPid = pid;
        inspector.clearProcess(pid);
      },
    });
    expect(terminatedPid as number | null).toBe(11304);
    expect(result.state).toBe('stale');
    expect(result.canTerminate).toBe(false);
  });
});
