import { afterAll, beforeAll, describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { _resetTelemetryWriterForTest } from '../../src/core/search/telemetry.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { chineseQuestionRecallContract, seedChineseQuestionRecall } from '../helpers/chinese-question-recall-contract.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;
describePostgres('Chinese question recall on isolated Postgres', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    resetGateway();
    configureGateway({ embedding_dimensions: 1536, env: {} });
    engine = await setupDB();
    await seedChineseQuestionRecall(engine);
  }, 90_000);
  afterAll(async () => {
    _resetTelemetryWriterForTest();
    resetGateway();
    await teardownDB();
  }, 30_000);
  chineseQuestionRecallContract(() => engine, hybridSearch);
});
