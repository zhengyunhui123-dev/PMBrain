import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { chineseQuestionRecallContract, seedChineseQuestionRecall } from './helpers/chinese-question-recall-contract.ts';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-zh-recall-'));
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_TEST_ALLOW_DATABASE_URL'];
const previous = new Map(keys.map(key => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
process.env.PMBRAIN_HOME = root;
mkdirSync(join(root, '.pmbrain'));
writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
const { WorkerPgliteEngine } = await import('../src/product/database/worker-engine.ts');
const { hybridSearch } = await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { _resetTelemetryWriterForTest } = await import('../src/core/search/telemetry.ts');
let engine: BrainEngine;

beforeAll(async () => {
  resetGateway();
  configureGateway({ env: {} });
  engine = new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({});
  await engine.initSchema();
  await seedChineseQuestionRecall(engine);
}, 90_000);

afterAll(async () => {
  _resetTelemetryWriterForTest();
  await engine?.disconnect();
  resetGateway();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}, 30_000);

describe('Chinese question recall on isolated PGLite', () => {
  chineseQuestionRecallContract(() => engine, hybridSearch);
});
