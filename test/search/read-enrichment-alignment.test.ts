import { test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { verifyReadEnrichment } from '../helpers/read-enrichment-alignment.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
afterAll(async () => { await engine.disconnect(); });
test('ranking metadata cannot borrow evidence from private pages or other Sources', async () => {
  await verifyReadEnrichment(engine);
});
