import { beforeAll, afterAll, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { verifyIdeaMigration } from '../helpers/facts-idea-migration-contract.ts';

const enabled = hasDatabase();
beforeAll(async () => { if (enabled) await setupDB(); }, 60000);
afterAll(async () => { if (enabled) await teardownDB(); });
(enabled ? test : test.skip)('idea migration preserves old facts on Postgres', async () => { await verifyIdeaMigration(getEngine()); }, 60000);
