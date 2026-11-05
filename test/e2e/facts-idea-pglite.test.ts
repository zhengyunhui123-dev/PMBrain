import { beforeAll, afterAll, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { verifyIdeaMigration, verifyStuckFactKindConstraint } from '../helpers/facts-idea-migration-contract.ts';

const engine = new PGLiteEngine();
beforeAll(async () => { await engine.connect({}); await engine.initSchema(); }, 180000);
afterAll(async () => { await engine.disconnect(); });
test('idea migration preserves old facts and accepts only supported kinds', async () => {
  await verifyIdeaMigration(engine);
  await verifyStuckFactKindConstraint(engine);
}, 120000);
