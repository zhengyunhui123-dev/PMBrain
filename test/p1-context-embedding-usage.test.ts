import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildContextDelta, buildContextPack } from '../src/core/context/context-pack.ts';
import { appendCheckpointManifest, getSessionContextState } from '../src/core/context/session-state.ts';
import { effectiveSurfaceForClient, filterOpsForSurface, STARTER_OPS } from '../src/mcp/surface.ts';
import { operations } from '../src/core/operations.ts';
import { makeEngineChatUsageSink } from '../src/core/ai/chat-usage.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM session_context_state');
  await engine.executeRaw('DELETE FROM chat_usage_log');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw('DELETE FROM oauth_clients');
});

describe('P1 Context/embedding/usage lifecycle', () => {
  test('session context persists standing entities and confirmed checkpoint pointers', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('projects/pmbrain', 'default', 'project', 'PMBrain', 'Desktop brain', '')`,
    );
    const first = await buildContextPack(engine, {
      sourceId: 'default', sessionId: 'session-a', entities: ['PMBrain'],
    });
    expect(first.pointers.map((pointer) => pointer.slug)).toContain('projects/pmbrain');
    await appendCheckpointManifest(
      engine, 'default', null, 'session-a',
      [{ slug: 'projects/pmbrain', title: 'PMBrain' }], 'compact-1',
    );
    const restored = await buildContextPack(engine, { sourceId: 'default', sessionId: 'session-a' });
    expect(restored.checkpoints[0]?.slug).toBe('projects/pmbrain');
    expect((await getSessionContextState(engine, 'default', null, 'session-a'))?.standing_entities).toEqual(['PMBrain']);
  });

  test('delta is Source-scoped and advances only the delivered session cursor', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('default-page', 'default', 'note', 'Default page', '', ''),
              ('other-page', 'other', 'note', 'Other page', '', '')`,
    );
    const delta = await buildContextDelta(engine, { sourceId: 'default', sessionId: 'delta-a' });
    expect(delta.pages.map((page) => page.slug)).toEqual(['default-page']);
    expect((await getSessionContextState(engine, 'default', null, 'delta-a'))?.last_wake_at).not.toBeNull();
  });

  test('delta keysets page and fact ties without losing the overflow tail', async () => {
    const timestamp = '2026-08-31T00:00:00.000Z';
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, updated_at)
       SELECT 'cursor-page-' || lpad(i::text, 3, '0'), 'default', 'note', 'Cursor page', '', '', $1
         FROM generate_series(1, 105) AS i`,
      [timestamp],
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, kind, source, valid_from, confidence, visibility, created_at)
       SELECT 'default', 'cursor fact ' || i::text, 'fact', 'test', $1, 0.9, 'world', $1
         FROM generate_series(1, 105) AS i`,
      [timestamp],
    );
    const first = await buildContextDelta(engine, {
      sourceId: 'default', sessionId: 'delta-ties', since: '2026-08-30T00:00:00.000Z',
    });
    const second = await buildContextDelta(engine, { sourceId: 'default', sessionId: 'delta-ties' });
    const third = await buildContextDelta(engine, { sourceId: 'default', sessionId: 'delta-ties' });
    expect(first).toMatchObject({ overflow: true });
    expect(second).toMatchObject({ overflow: true });
    expect(third).toMatchObject({ overflow: false });
    expect(first.pages).toHaveLength(50);
    expect(first.facts).toHaveLength(50);
    expect(second.pages).toHaveLength(50);
    expect(second.facts).toHaveLength(50);
    expect(third.pages).toHaveLength(5);
    expect(third.facts).toHaveLength(5);
    expect(new Set([...first.pages, ...second.pages, ...third.pages].map((page) => page.slug)).size).toBe(105);
    expect(new Set([...first.facts, ...second.facts, ...third.facts].map((fact) => fact.id)).size).toBe(105);
  });

  test('chunk writes stamp text hash and a complete page embedding signature', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('embedded', 'default', 'note', 'Embedded', 'body', '')`,
    );
    await engine.upsertChunks('embedded', [{
      chunk_index: 0,
      chunk_text: 'stable content',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array(1536).fill(0.01),
      model: 'test:model',
      token_count: 2,
    }], { sourceId: 'default' });
    const [row] = await engine.executeRaw<{ embedded_text_hash: string | null; embedding_signature: string | null }>(
      `SELECT cc.embedded_text_hash, p.embedding_signature
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'embedded' AND p.source_id = 'default'`,
    );
    expect(row?.embedded_text_hash).toHaveLength(32);
    expect(row?.embedding_signature).toBe('test:model:1536');
    await engine.executeRaw(`UPDATE content_chunks SET chunk_text = 'changed elsewhere'`);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  }, 20_000);

  test('embedding migration plan and missing confirmation never mutate vectors or receipts', async () => {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      await runMigrateEmbeddings(engine, ['--to', 'zhipu:embedding-3', '--dry-run']);
      expect(await engine.getConfig('embedding.migration.inflight')).toBeNull();
      expect(await engine.getConfig('embedding.migration.completed')).toBeNull();
      await expect(runMigrateEmbeddings(engine, ['--to', 'zhipu:embedding-3']))
        .rejects.toThrow('requires explicit --yes');
      expect(await engine.getConfig('embedding.migration.inflight')).toBeNull();
    } finally {
      console.log = originalLog;
    }
  });

  test('surface ceiling is monotonic and starter names all exist', () => {
    const effective = effectiveSurfaceForClient({ ceiling: 'starter', clientSurface: 'full' });
    expect(effective).toBe('starter');
    const names = new Set(operations.map((op) => op.name));
    expect([...STARTER_OPS].filter((name) => !names.has(name))).toEqual([]);
    expect(filterOpsForSurface(operations, 'verbs').every((op) => op.verb === true)).toBe(true);
  });

  test('request_tools cannot reveal above the ceiling or override an operator pin', async () => {
    const requestTools = operations.find((operation) => operation.name === 'request_tools');
    if (!requestTools) throw new Error('request_tools operation missing');
    const baseContext = {
      engine,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
      auth: { clientId: 'surface-client', scopes: ['admin'] },
    } as any;
    const catalog = await requestTools.handler(
      { ...baseContext, surfaceCeiling: 'verbs' },
      {},
    ) as { tools: Array<{ name: string }> };
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(
      ['context_pack', 'delta', 'entity', 'forget', 'recall', 'remember', 'synthesize'],
    );

    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, surface, surface_set_by)
       VALUES ('surface-client', 'Surface client', 'read', 'full', 'operator')`,
    );
    await expect(requestTools.handler(
      { ...baseContext, surfaceCeiling: 'full' },
      { surface: 'starter' },
    )).rejects.toThrow('pinned by the operator');
  });

  test('chat ledger sink records tokens without prompt content', async () => {
    const sink = makeEngineChatUsageSink(engine);
    await sink({
      model: 'anthropic:claude-sonnet-4-6', provider: 'anthropic', phase: 'test',
      input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 0, cost_usd: 0.001,
    });
    const [row] = await engine.executeRaw<{ model: string; input_tokens: number; cost_usd: number }>(
      'SELECT model, input_tokens, cost_usd FROM chat_usage_log',
    );
    expect(row).toMatchObject({ model: 'anthropic:claude-sonnet-4-6', input_tokens: 10 });
  });
});
