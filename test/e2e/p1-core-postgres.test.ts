import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildContextDelta } from '../../src/core/context/context-pack.ts';
import { makeEngineChatUsageSink } from '../../src/core/ai/chat-usage.ts';
import { getConn, getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('P1 PostgreSQL parity', () => {
  beforeAll(async () => setupDB());
  afterAll(async () => teardownDB());
  beforeEach(async () => {
    await getConn().unsafe(`DELETE FROM session_context_state WHERE session_id LIKE 'p1-postgres-%'`);
    await getConn().unsafe(`DELETE FROM chat_usage_log WHERE phase = 'p1-postgres'`);
    await getConn().unsafe(`DELETE FROM pages WHERE slug = 'p1-postgres-page'`);
  });

  test('Schema 121 exposes embedding, OAuth, context and usage contracts', async () => {
    const columns = await getConn().unsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'pages' AND column_name = 'embedding_signature')
           OR (table_name = 'content_chunks' AND column_name = 'embedded_text_hash')
           OR (table_name = 'oauth_clients' AND column_name IN ('surface', 'surface_set_by'))
        ORDER BY table_name, column_name`,
    );
    expect(columns).toHaveLength(4);
    const tables = await getConn().unsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('session_context_state', 'chat_usage_log')
        ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(['chat_usage_log', 'session_context_state']);
    const contextColumns = await getConn().unsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'session_context_state'
          AND column_name IN ('page_cursor_at', 'page_cursor_slug', 'fact_cursor_at', 'fact_cursor_id')
        ORDER BY column_name`,
    );
    expect(contextColumns.map((row) => row.column_name)).toEqual([
      'fact_cursor_at', 'fact_cursor_id', 'page_cursor_at', 'page_cursor_slug',
    ]);
  });

  test('Postgres stamps embedding receipts and detects later text drift', async () => {
    const engine = getEngine();
    await getConn().unsafe(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('p1-postgres-page', 'default', 'note', 'P1 Postgres', 'body', '')`,
    );
    await engine.upsertChunks('p1-postgres-page', [{
      chunk_index: 0, chunk_text: 'stable', chunk_source: 'compiled_truth',
      embedding: new Float32Array(1536).fill(0.01), model: 'test:model', token_count: 1,
    }], { sourceId: 'default' });
    const [receipt] = await getConn().unsafe<{ embedded_text_hash: string; embedding_signature: string }[]>(
      `SELECT cc.embedded_text_hash, p.embedding_signature
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'p1-postgres-page' AND p.source_id = 'default'`,
    );
    expect(receipt.embedding_signature).toBe('test:model:1536');
    expect(receipt.embedded_text_hash).toHaveLength(32);
    await getConn().unsafe(`UPDATE content_chunks SET chunk_text = 'changed' WHERE page_id = (SELECT id FROM pages WHERE slug = 'p1-postgres-page' AND source_id = 'default')`);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBeGreaterThanOrEqual(1);
  });

  test('Context delta and usage sink use the same Source-safe contracts', async () => {
    const engine = getEngine();
    await getConn().unsafe(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('p1-postgres-page', 'default', 'note', 'P1 Postgres', '', '')`,
    );
    const delta = await buildContextDelta(engine, { sourceId: 'default', sessionId: 'p1-postgres-delta' });
    expect(delta.pages.some((page) => page.slug === 'p1-postgres-page')).toBe(true);
    await makeEngineChatUsageSink(engine)({
      model: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', phase: 'p1-postgres',
      input_tokens: 2, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.0001,
    });
    const usage = await getConn().unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM chat_usage_log WHERE phase = 'p1-postgres'`);
    expect(usage[0]?.count).toBe(1);
  });
});
