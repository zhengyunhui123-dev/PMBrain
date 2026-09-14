import { test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { verifyKnowledgeViews } from '../helpers/admin-knowledge-view-cases.ts';

(hasDatabase() ? test : test.skip)('Postgres knowledge columns follow provenance with stable pagination', async () => {
  const engine = await setupDB();
  try {
    await verifyKnowledgeViews(engine);
  } finally {
    await teardownDB();
  }
}, 60_000);
