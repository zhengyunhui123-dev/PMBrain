import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('personal', 'Personal') ON CONFLICT (id) DO NOTHING`,
  );
  await engine.setConfig('dream.patterns.enabled', 'true');
  await engine.setConfig('dream.patterns.min_evidence', '1');
});

describe('patterns Source scope', () => {
  test('reads only reflections owned by the cycle Source', async () => {
    await engine.putPage('wiki/personal/reflections/default-one', {
      type: 'reflection', title: 'Default', compiled_truth: 'default evidence', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('wiki/personal/reflections/personal-one', {
      type: 'reflection', title: 'Personal', compiled_truth: 'personal evidence', timeline: '', frontmatter: {},
    }, { sourceId: 'personal' });

    const result = await runPhasePatterns(engine, {
      brainDir: '.',
      dryRun: true,
      sourceId: 'personal',
    });

    expect(result.status).toBe('ok');
    expect(result.details.reflections_considered).toBe(1);
  }, 120_000);
});
