/**
 * PostgreSQL parity coverage for Dream-derived retrieval visibility.
 *
 * This suite is skipped unless the shared E2E helper finds DATABASE_URL. When
 * present, setupDB() rejects non-test database names before connecting or
 * truncating, so this contract can never fall through to a configured user DB.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { runSubagentsInline } from '../../src/core/cycle/inline-drain.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

function atomChat(opts: ChatOpts): Promise<ChatResult> {
  void opts;
  return Promise.resolve({
    text: JSON.stringify([{
      title: 'Postgres retrieval atom',
      atom_type: 'insight',
      body: 'Postgresatomvisibilitytoken confirms the derived-page path.',
    }]),
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

describePostgres('PostgreSQL Dream-derived retrieval visibility', () => {
  let engine: BrainEngine;

  beforeAll(async () => {
    resetGateway();
    engine = await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
    resetGateway();
  }, 30_000);

  test('atom and concept pages enter chunks and keyword search without Embedding', async () => {
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{
        filePath: '/fake/postgres-meeting.txt',
        content: 'postgres meeting transcript',
        contentHash: 'postgres-atom-retrieval-source-hash',
      }],
      _pages: [],
      _chat: atomChat,
    });
    await runPhaseSynthesizeConcepts(engine, {
      _atoms: [
        {
          slug: 'atoms/postgres-a1',
          title: 'Postgresconceptvisibilitytoken alpha',
          body: 'First PostgreSQL observation.',
          concept_refs: ['postgres-retrieval-visibility'],
        },
        {
          slug: 'atoms/postgres-a2',
          title: 'Postgresconceptvisibilitytoken beta',
          body: 'Second PostgreSQL observation.',
          concept_refs: ['postgres-retrieval-visibility'],
        },
      ],
    });

    const chunks = await engine.executeRaw<{ type: string; count: string }>(
      `SELECT p.type, count(*)::text AS count
         FROM pages p
         JOIN content_chunks cc ON cc.page_id = p.id
        WHERE p.type IN ('atom', 'concept')
        GROUP BY p.type`,
    );
    expect(chunks.some((row) => row.type === 'atom' && Number(row.count) > 0)).toBe(true);
    expect(chunks.some((row) => row.type === 'concept' && Number(row.count) > 0)).toBe(true);

    const atomHits = await engine.searchKeyword('postgresatomvisibilitytoken', {
      sourceId: 'default',
    });
    const conceptHits = await engine.searchKeyword('postgresconceptvisibilitytoken', {
      sourceId: 'default',
    });
    expect(atomHits.some((hit) => hit.slug.startsWith('atoms/'))).toBe(true);
    expect(conceptHits.some((hit) => hit.slug === 'concepts/postgres-retrieval-visibility')).toBe(true);
  }, 90_000);

  test('private Dream queues can also drain inline on PostgreSQL', async () => {
    const queue = new MinionQueue(engine);
    const queueName = `dream-inline-postgres-${Date.now()}`;
    const child = await queue.add(
      'subagent',
      {
        prompt: 'Return a deterministic PostgreSQL parity result.',
        model: 'anthropic:claude-haiku-4-5',
        max_turns: 1,
        allowed_slug_prefixes: ['wiki/*'],
      },
      { queue: queueName, timeout_ms: 5_000 },
      { allowProtectedSubmit: true },
    );
    await runSubagentsInline(
      engine,
      queue,
      queueName,
      undefined,
      async () => ({ postgres_inline: true }),
      5_000,
    );
    const completed = await queue.getJob(child.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ postgres_inline: true });
  }, 30_000);

  test('structured Dream verdict fields round-trip on PostgreSQL', async () => {
    await engine.putDreamVerdict('/tmp/postgres-structured.md', 'postgres-structured-hash', {
      worth_processing: true,
      reasons: ['durable postgres verdict'],
      score: 0.79,
      content_type: 'technical',
      segments: [{ quote: 'PostgreSQL parity', note: 'storage contract' }],
      entities: ['PMBrain'],
      model: 'test:postgres-triage',
      triage_version: 1,
    });
    const verdict = await engine.getDreamVerdict(
      '/tmp/postgres-structured.md',
      'postgres-structured-hash',
    );
    expect(verdict?.score).toBe(0.79);
    expect(verdict?.segments).toEqual([{ quote: 'PostgreSQL parity', note: 'storage contract' }]);
    expect(verdict?.entities).toEqual(['PMBrain']);
    expect(verdict?.model).toBe('test:postgres-triage');
    expect(verdict?.triage_version).toBe(1);
  });
});
