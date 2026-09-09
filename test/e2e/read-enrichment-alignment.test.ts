import { beforeAll, afterAll, describe, test } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { verifyReadEnrichment } from '../helpers/read-enrichment-alignment.ts';

const run = hasDatabase();
beforeAll(async () => { if (run) await setupDB(); });
afterAll(async () => { if (run) await teardownDB(); });
(run ? describe : describe.skip)('Postgres ranking permission alignment', () => {
  test('private and cross-Source evidence cannot affect ranking', async () => {
    await verifyReadEnrichment(getEngine());
  });
});
