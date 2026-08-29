import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pmbrain-sync-ledger-'));
});

afterEach(() => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe('source-scoped bounded sync failure ledger', () => {
  test('same file blocks twice, auto-skips on third identical failure, and remains visible', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home, GBRAIN_SYNC_AUTOSKIP_AFTER: '3' }, async () => {
      const { applySyncFailureGate, loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
      let advances = 0;
      const run = (commit: string) => applySyncFailureGate({
        sourceId: 'alpha',
        failedFiles: [{ path: 'notes/bad.md', error: 'YAML parse failed: bad mapping' }],
        succeededPaths: [],
        commit,
        skipFailed: false,
        advance: async () => { advances += 1; },
      });

      expect((await run('c1')).advanced).toBe(false);
      expect((await run('c2')).advanced).toBe(false);
      const third = await run('c3');
      expect(third.advanced).toBe(true);
      expect(third.autoSkipped).toEqual(['notes/bad.md']);
      expect(advances).toBe(1);
      const row = loadSyncFailures().find((item) => item.source_id === 'alpha' && item.path === 'notes/bad.md');
      expect(row?.state).toBe('auto_skipped');
      expect(row?.attempts).toBe(3);
    });
  });

  test('database, embedding, and Git sentinel failures never auto-skip', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home, GBRAIN_SYNC_AUTOSKIP_AFTER: '1' }, async () => {
      const { applySyncFailureGate } = await import('../src/core/sync-failure-ledger.ts');
      for (const failure of [
        { path: '<head>', error: 'git history rewrite detected' },
        { path: '<database>', error: 'connection terminated unexpectedly' },
        { path: 'notes/good.md', error: 'embedding request timeout' },
      ]) {
        let advanced = false;
        const result = await applySyncFailureGate({
          sourceId: 'alpha',
          failedFiles: [failure],
          succeededPaths: [],
          commit: `${failure.path}-c1`,
          skipFailed: false,
          advance: async () => { advanced = true; },
        });
        expect(result.advanced).toBe(false);
        expect(result.autoSkipped).toEqual([]);
        expect(advanced).toBe(false);
      }
    });
  });

  test('failure counters and clearing are isolated by Source', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const { recordFailures, clearFailures, loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
      recordFailures('alpha', [{ path: 'same.md', error: 'parse failed' }], 'a1');
      recordFailures('alpha', [{ path: 'same.md', error: 'parse failed' }], 'a2');
      recordFailures('beta', [{ path: 'same.md', error: 'parse failed' }], 'b1');
      clearFailures('alpha', ['same.md']);
      const rows = loadSyncFailures();
      expect(rows).toHaveLength(1);
      expect(rows[0].source_id).toBe('beta');
      expect(rows[0].attempts).toBe(1);
    });
  });

  test('a different error class for the same file restarts the autoskip counter', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const { recordFailures, loadSyncFailures } = await import('../src/core/sync-failure-ledger.ts');
      recordFailures('source-a', [{ path: 'notes/bad.md', error: 'SLUG_MISMATCH' }], 'c1');
      recordFailures('source-a', [{ path: 'notes/bad.md', error: 'invalid UTF-8' }], 'c2');
      const row = loadSyncFailures().find(entry => entry.source_id === 'source-a' && entry.path === 'notes/bad.md');
      expect(row?.code).toBe('INVALID_UTF8');
      expect(row?.attempts).toBe(1);
    });
  });
});
