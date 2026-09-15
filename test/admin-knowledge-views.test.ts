import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { verifyKnowledgeViews } from './helpers/admin-knowledge-view-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

test('knowledge columns follow provenance without rewriting page types', async () => {
  await verifyKnowledgeViews(engine);
}, 60_000);
