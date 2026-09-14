import { test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { verifyKnowledgeViews } from './helpers/admin-knowledge-view-cases.ts';

test('knowledge columns follow provenance without rewriting page types', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    await verifyKnowledgeViews(engine);
  } finally {
    await engine.disconnect();
  }
}, 60_000);
