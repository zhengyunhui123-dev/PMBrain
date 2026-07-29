import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';

describe('Dream embedding configuration', () => {
  const originalPmbrainHome = process.env.PMBRAIN_HOME;
  const originalGbrainHome = process.env.GBRAIN_HOME;
  const originalModel = process.env.PMBRAIN_EMBEDDING_MODEL;
  const originalLegacyModel = process.env.GBRAIN_EMBEDDING_MODEL;
  const originalDimensions = process.env.PMBRAIN_EMBEDDING_DIMENSIONS;
  const originalLegacyDimensions = process.env.GBRAIN_EMBEDDING_DIMENSIONS;

  afterEach(() => {
    restoreEnv('PMBRAIN_HOME', originalPmbrainHome);
    restoreEnv('GBRAIN_HOME', originalGbrainHome);
    restoreEnv('PMBRAIN_EMBEDDING_MODEL', originalModel);
    restoreEnv('GBRAIN_EMBEDDING_MODEL', originalLegacyModel);
    restoreEnv('PMBRAIN_EMBEDDING_DIMENSIONS', originalDimensions);
    restoreEnv('GBRAIN_EMBEDDING_DIMENSIONS', originalLegacyDimensions);
  });

  test('skips embed when no embedding model is explicitly configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pmbrain-cycle-no-embedding-'));
    const brainDir = join(home, 'brain');
    const engine = new PGLiteEngine();
    mkdirSync(join(home, '.pmbrain'), { recursive: true });
    mkdirSync(brainDir, { recursive: true });
    writeFileSync(
      join(home, '.pmbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', embedding_disabled: true }),
    );
    process.env.PMBRAIN_HOME = home;
    delete process.env.GBRAIN_HOME;
    delete process.env.PMBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.PMBRAIN_EMBEDDING_DIMENSIONS;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;

    try {
      await engine.connect({});
      await engine.initSchema();
      const report = await runCycle(engine, { brainDir, phases: ['embed'] });
      expect(report.phases).toHaveLength(1);
      expect(report.phases[0]).toMatchObject({
        phase: 'embed',
        status: 'skipped',
        details: { reason: 'embedding_not_configured' },
      });
    } finally {
      await engine.disconnect();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
