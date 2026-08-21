import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

describe('PGLite structured Dream verdict storage', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 90_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('migration v116 round-trips score, segments, entities, model and version', async () => {
    await engine.putDreamVerdict('/tmp/structured.md', 'hash-structured', {
      worth_processing: true,
      reasons: ['durable'],
      score: 0.88,
      content_type: 'strategy',
      segments: [{ quote: 'durable decision', note: 'core' }],
      entities: ['PMBrain'],
      model: 'test:triage',
      triage_version: 1,
    });
    const row = await engine.getDreamVerdict('/tmp/structured.md', 'hash-structured');
    expect(row).not.toBeNull();
    expect(row?.score).toBe(0.88);
    expect(row?.segments).toEqual([{ quote: 'durable decision', note: 'core' }]);
    expect(row?.entities).toEqual(['PMBrain']);
    expect(row?.model).toBe('test:triage');
    expect(row?.triage_version).toBe(1);
  });
});
