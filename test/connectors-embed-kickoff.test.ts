/**
 * connectors-embed-kickoff.test.ts — ER-1: the embed kickoff is engine-branched.
 * Postgres → submitEmbedBackfill; PGLite → runEmbedCore inline (NEVER
 * submitEmbedBackfill, which refuses no_worker_surface and cooldown-blocks).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeKickoffEmbed } from '../src/core/connectors/sync.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

function fakeEngine(kind: 'postgres' | 'pglite', config: Record<string, string> = {}): BrainEngine {
  return {
    kind,
    getConfig: async (k: string) => config[k] ?? null,
    setConfig: async () => {},
  } as unknown as BrainEngine;
}

const EMBED_CFG = { embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: '768' };
const baseOpts = { provider: 'chatgpt' as const };

describe('maybeKickoffEmbed', () => {
  test('below threshold → no embed, neither path called', async () => {
    let submitCalls = 0;
    let embedCalls = 0;
    const out = await maybeKickoffEmbed(
      fakeEngine('postgres'),
      'default',
      10, // < default 25
      baseOpts,
      { submitEmbedBackfill: (async () => { submitCalls++; return { status: 'submitted' }; }) as never, runEmbedCore: (async () => { embedCalls++; return {} as never; }) as never },
      () => {},
    );
    expect(out).toBe('below_threshold');
    expect(submitCalls).toBe(0);
    expect(embedCalls).toBe(0);
  });

  test('Postgres over threshold → submitEmbedBackfill called (NOT runEmbedCore)', async () => {
    let submitCalls = 0;
    let embedCalls = 0;
    const out = await maybeKickoffEmbed(
      fakeEngine('postgres', EMBED_CFG),
      'default',
      30,
      baseOpts,
      { submitEmbedBackfill: (async () => { submitCalls++; return { status: 'submitted' }; }) as never, runEmbedCore: (async () => { embedCalls++; return {} as never; }) as never },
      () => {},
    );
    expect(out).toBe('postgres_submitted');
    expect(submitCalls).toBe(1);
    expect(embedCalls).toBe(0);
  });

  test('Postgres cooldown/spend_capped/no_worker_surface pass through, never thrown', async () => {
    for (const status of ['cooldown', 'spend_capped', 'no_worker_surface'] as const) {
      const out = await maybeKickoffEmbed(
        fakeEngine('postgres', EMBED_CFG),
        'default',
        30,
        baseOpts,
        { submitEmbedBackfill: (async () => ({ status })) as never, runEmbedCore: (async () => ({} as never)) as never },
        () => {},
      );
      expect(out).toBe(status);
    }
  });

  test('PGLite over threshold → runEmbedCore inline, NEVER submitEmbedBackfill (ER-1)', async () => {
    let submitCalls = 0;
    let embedCalls = 0;
    const out = await maybeKickoffEmbed(
      fakeEngine('pglite', EMBED_CFG),
      'default',
      30,
      baseOpts,
      { submitEmbedBackfill: (async () => { submitCalls++; return { status: 'submitted' }; }) as never, runEmbedCore: (async () => { embedCalls++; return {} as never; }) as never },
      () => {},
    );
    expect(out).toBe('pglite_inline');
    expect(embedCalls).toBe(1);
    expect(submitCalls).toBe(0); // the whole point of ER-1
  });

  test('threshold honors connectors.embed_kickoff_min_pages config', async () => {
    const out = await maybeKickoffEmbed(
      fakeEngine('pglite', { ...EMBED_CFG, 'connectors.embed_kickoff_min_pages': '5' }),
      'default',
      6, // >= 5 now
      baseOpts,
      { runEmbedCore: (async () => ({} as never)) as never },
      () => {},
    );
    expect(out).toBe('pglite_inline');
  });

  test('no embedding_model + embedding_dimensions → none (no ZeroEntropy fallback)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pm-embed-none-'));
    let submitCalls = 0;
    let embedCalls = 0;
    try {
      await withEnv({ PMBRAIN_HOME: tmp }, async () => {
        const out = await maybeKickoffEmbed(
          fakeEngine('postgres'),
          'default',
          30,
          baseOpts,
          { submitEmbedBackfill: (async () => { submitCalls++; return { status: 'submitted' }; }) as never, runEmbedCore: (async () => { embedCalls++; return {} as never; }) as never },
          () => {},
        );
        expect(out).toBe('none');
        expect(submitCalls).toBe(0);
        expect(embedCalls).toBe(0);
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
