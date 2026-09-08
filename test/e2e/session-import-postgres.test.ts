import { beforeAll, afterAll, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { verifySessionImport } from '../helpers/session-import-contract.ts';

const enabled = hasDatabase();
beforeAll(async () => { if (enabled) await setupDB(); }, 60000);
afterAll(async () => { if (enabled) await teardownDB(); });
(enabled ? test : test.skip)('manual session import preserves Source, deduplication and original files on Postgres', async () => {
  await verifySessionImport(getEngine());
}, 60000);
