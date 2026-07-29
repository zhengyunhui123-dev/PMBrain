import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRecommendationContext } from '../src/core/remediation/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

describe('embedding recommendation configuration authority', () => {
  const originalPmbrainHome = process.env.PMBRAIN_HOME;
  const originalGbrainHome = process.env.GBRAIN_HOME;

  afterEach(() => {
    restoreEnv('PMBRAIN_HOME', originalPmbrainHome);
    restoreEnv('GBRAIN_HOME', originalGbrainHome);
  });

  test('an embedding-disabled config file does not revive a legacy DB model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pmbrain-remediation-no-embedding-'));
    const engine = new PGLiteEngine();
    mkdirSync(join(home, '.pmbrain'), { recursive: true });
    writeFileSync(
      join(home, '.pmbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', embedding_disabled: true }),
    );
    process.env.PMBRAIN_HOME = home;
    delete process.env.GBRAIN_HOME;
    // The global test preload intentionally installs a legacy OpenAI model;
    // production has no such preload, so clear it for this no-model case.
    resetGateway();

    try {
      await engine.connect({});
      await engine.initSchema();
      await engine.setConfig('embedding_model', 'zeroentropyai:zembed-1');
      await engine.setConfig('embedding_dimensions', '1280');

      const context = await loadRecommendationContext(engine);
      expect(context.embeddingModel).toBeUndefined();
      expect(context.embeddingDimensions).toBeUndefined();
      expect(context.embeddingProviderConfigured).toBe(false);
    } finally {
      await engine.disconnect();
      rmSync(home, { recursive: true, force: true });
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: { ...process.env },
      });
    }
  }, 60_000);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
