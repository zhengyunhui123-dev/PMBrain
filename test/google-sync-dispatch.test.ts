/**
 * Google-kind sync dispatch: performSync must call runGoogleSync, not git pull.
 * A git-kind source must not enter the google vault path.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { performSync } from '../src/commands/sync.ts';
import { CredentialError } from '../src/core/creds/errors.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('performSync google-kind dispatch', () => {
  test('google-kind source calls runGoogleSync (vault miss), not git', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pmbrain-gsync-'));
    const dir = join(home, 'google-src');
    mkdirSync(dir, { recursive: true });
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: undefined }, async () => {
      await addSource(engine, {
        id: 'gmail-alice',
        google: {
          account: 'alice@example.com',
          services: ['gmail'],
          historyDays: 90,
          dir,
        },
      });
      let err: unknown;
      try {
        await performSync(engine, { sourceId: 'gmail-alice', skipLock: true });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CredentialError);
      expect((err as CredentialError).code).toBe('not_connected');
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toMatch(/not a git|not a repository|no local_path|git pull/i);
    });
  });

  test('path/git source does not enter the google vault path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pmbrain-gsync-git-'));
    const dir = join(home, 'wiki');
    mkdirSync(dir, { recursive: true });
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: undefined }, async () => {
      await addSource(engine, { id: 'wiki', localPath: dir });
      let err: unknown;
      try {
        await performSync(engine, { sourceId: 'wiki', skipLock: true, noPull: true });
      } catch (e) {
        err = e;
      }
      if (err) {
        expect(err).not.toBeInstanceOf(CredentialError);
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('not_connected');
        expect(msg).not.toContain('Google source');
      }
    });
  });
});
