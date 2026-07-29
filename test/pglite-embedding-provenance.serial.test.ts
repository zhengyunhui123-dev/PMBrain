import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const EMBEDDING_MODEL = 'ollama:qwen3-embedding:0.6b';
const EMBEDDING_DIMS = 3;

function markdown(title: string): string {
  return [
    '---',
    'type: note',
    `title: ${title}`,
    '---',
    '',
    'Stable provenance regression body.',
  ].join('\n');
}

describe('PGLite embedding provenance', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    resetGateway();
    configureGateway({
      embedding_model: EMBEDDING_MODEL,
      embedding_dimensions: EMBEDDING_DIMS,
      env: {},
    });
    __setEmbedTransportForTests(async (args: { values: string[] }) => ({
      embeddings: args.values.map(() => [0.1, 0.2, 0.3]),
    }) as never);
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    resetGateway();
  }, 60_000);

  test('records the explicit model that produced an imported embedding', async () => {
    await importFromContent(engine, 'notes/explicit-model', markdown('Explicit model'));

    const rows = await engine.executeRaw<{ model: string | null; has_embedding: boolean }>(
      `SELECT cc.model, cc.embedding IS NOT NULL AS has_embedding
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = 'default' AND p.slug = 'notes/explicit-model'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.has_embedding)).toBe(true);
    expect(rows.every((row) => row.model === EMBEDDING_MODEL)).toBe(true);
  });

  test('no-embed rewrite with unchanged chunk text preserves the existing embedding model', async () => {
    const slug = 'notes/preserve-model';
    await importFromContent(engine, slug, markdown('Original title'), { noEmbed: true });
    const chunks = await engine.getChunks(slug);
    expect(chunks.length).toBeGreaterThan(0);

    await engine.upsertChunks(
      slug,
      chunks.map((chunk) => ({
        chunk_index: chunk.chunk_index,
        chunk_text: chunk.chunk_text,
        chunk_source: chunk.chunk_source,
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        model: EMBEDDING_MODEL,
      })),
    );

    await importFromContent(engine, slug, markdown('Updated title'), { noEmbed: true });

    const rows = await engine.executeRaw<{ model: string | null; has_embedding: boolean }>(
      `SELECT cc.model, cc.embedding IS NOT NULL AS has_embedding
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = 'default' AND p.slug = $1`,
      [slug],
    );
    expect(rows.every((row) => row.has_embedding)).toBe(true);
    expect(rows.every((row) => row.model === EMBEDDING_MODEL)).toBe(true);
  });

  test('stores NULL model provenance for a new chunk without an embedding', async () => {
    await importFromContent(engine, 'notes/no-embedding', markdown('No embedding'), { noEmbed: true });

    const rows = await engine.executeRaw<{ model: string | null; has_embedding: boolean }>(
      `SELECT cc.model, cc.embedding IS NOT NULL AS has_embedding
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = 'default' AND p.slug = 'notes/no-embedding'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.has_embedding === false)).toBe(true);
    expect(rows.every((row) => row.model === null)).toBe(true);
  });
});
