/**
 * Regression coverage for Dream-derived atom/concept retrieval visibility.
 *
 * Product contract:
 * - Dream output must enter content_chunks so keyword search can find it.
 * - No embedding configuration still writes pages + chunks, without a model call.
 * - Explicit embedding configuration embeds the derived chunks and records provenance.
 * - Atom writes stay inside the source that produced them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const EMBEDDING_MODEL = 'ollama:qwen3-embedding:0.6b';
const EMBEDDING_DIMS = 3;

let engine: PGLiteEngine;

function atomChat(title: string, body: string): (opts: ChatOpts) => Promise<ChatResult> {
  return async () => ({
    text: JSON.stringify([{ title, atom_type: 'insight', body }]),
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

beforeAll(async () => {
  // Initialize the test schema at the same dimensions used by the deterministic
  // embedding transport below. Individual tests may then reset the gateway to
  // exercise the explicit no-embedding branch against the same disposable DB.
  configureGateway({
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: EMBEDDING_DIMS,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  __setEmbedTransportForTests(null);
  resetGateway();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
}, 60_000);

describe('Dream-derived pages reach retrieval without Embedding', () => {
  test('atom page is chunked, keyword-searchable, and source-scoped', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dream-work', 'dream-work')
       ON CONFLICT (id) DO NOTHING`,
    );

    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'dream-work',
      _transcripts: [{
        filePath: '/fake/meeting.txt',
        content: 'meeting transcript',
        contentHash: 'atom-retrieval-source-hash',
      }],
      _pages: [],
      _chat: atomChat(
        'Prototype procurement signal',
        'Enterprise buyers require prototypevisibilitytoken before procurement.',
      ),
    });

    expect(result.status).toBe('ok');
    const rows = await engine.executeRaw<{
      slug: string;
      source_id: string;
      model: string | null;
      has_embedding: boolean;
    }>(
      `SELECT p.slug, p.source_id, cc.model,
              cc.embedding IS NOT NULL AS has_embedding
         FROM pages p
         JOIN content_chunks cc ON cc.page_id = p.id
        WHERE p.type = 'atom'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.source_id === 'dream-work')).toBe(true);
    expect(rows.every((row) => row.has_embedding === false)).toBe(true);
    expect(rows.every((row) => row.model === null)).toBe(true);

    const scopedHits = await engine.searchKeyword('prototypevisibilitytoken', {
      sourceId: 'dream-work',
    });
    expect(scopedHits.some((hit) => hit.slug === rows[0].slug)).toBe(true);
    const defaultHits = await engine.searchKeyword('prototypevisibilitytoken', {
      sourceId: 'default',
    });
    expect(defaultHits.some((hit) => hit.slug === rows[0].slug)).toBe(false);
  }, 60_000);

  test('concept page is chunked and keyword-searchable', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: [
        {
          slug: 'atoms/a1',
          title: 'Conceptvisibilitytoken alpha',
          body: 'First grounded observation.',
          concept_refs: ['retrieval-visibility'],
        },
        {
          slug: 'atoms/a2',
          title: 'Conceptvisibilitytoken beta',
          body: 'Second grounded observation.',
          concept_refs: ['retrieval-visibility'],
        },
      ],
    });

    expect(result.status).toBe('ok');
    const rows = await engine.executeRaw<{
      slug: string;
      model: string | null;
      has_embedding: boolean;
    }>(
      `SELECT p.slug, cc.model, cc.embedding IS NOT NULL AS has_embedding
         FROM pages p
         JOIN content_chunks cc ON cc.page_id = p.id
        WHERE p.source_id = 'default'
          AND p.slug = 'concepts/retrieval-visibility'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.has_embedding === false)).toBe(true);
    expect(rows.every((row) => row.model === null)).toBe(true);

    const hits = await engine.searchKeyword('conceptvisibilitytoken', {
      sourceId: 'default',
    });
    expect(hits.some((hit) => hit.slug === 'concepts/retrieval-visibility')).toBe(true);
  }, 60_000);
});

describe('Dream-derived pages honor explicit Embedding configuration', () => {
  test('atom and concept chunks carry the configured model provenance', async () => {
    configureGateway({
      embedding_model: EMBEDDING_MODEL,
      embedding_dimensions: EMBEDDING_DIMS,
      env: {},
    });
    __setEmbedTransportForTests(async (args: { values: string[] }) => ({
      embeddings: args.values.map(() => [0.1, 0.2, 0.3]),
    }) as never);

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{
        filePath: '/fake/embedded-meeting.txt',
        content: 'embedded meeting transcript',
        contentHash: 'embedded-atom-source-hash',
      }],
      _pages: [],
      _chat: atomChat('Embedded atom', 'Embedding provenance atom body.'),
    });
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [
        {
          slug: 'atoms/e1',
          title: 'Embedded concept alpha',
          body: 'First embedding observation.',
          concept_refs: ['embedded-concept'],
        },
        {
          slug: 'atoms/e2',
          title: 'Embedded concept beta',
          body: 'Second embedding observation.',
          concept_refs: ['embedded-concept'],
        },
      ],
    });

    const rows = await engine.executeRaw<{
      type: string;
      model: string | null;
      has_embedding: boolean;
    }>(
      `SELECT p.type, cc.model, cc.embedding IS NOT NULL AS has_embedding
         FROM pages p
         JOIN content_chunks cc ON cc.page_id = p.id
        WHERE p.type IN ('atom', 'concept')
          AND (p.slug LIKE 'atoms/%' OR p.slug = 'concepts/embedded-concept')`,
    );
    expect(rows.some((row) => row.type === 'atom')).toBe(true);
    expect(rows.some((row) => row.type === 'concept')).toBe(true);
    expect(rows.every((row) => row.has_embedding)).toBe(true);
    expect(rows.every((row) => row.model === EMBEDDING_MODEL)).toBe(true);
  }, 60_000);
});
