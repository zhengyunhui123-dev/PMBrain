/**
 * PMBrain Open Loops extras (D5/D16/D22): lane-aware close, unmatched
 * counterparties, meeting LLM default OFF, google-kind facts skip.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach, mock } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  addSuppression,
  closeThreadLoops,
  listOpenLoops,
  upsertOpenLoop,
  type OpenLoopUpsert,
} from '../src/core/loops/loops-store.ts';
import { resolveLoopCounterpartySlug } from '../src/core/loops/counterparty.ts';
import { scanMeetingPages } from '../src/core/loops/detectors/meetings.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';

const chat = mock(async () => ({
  text: '{"commitments":[{"direction":"owed_by_me","text":"send the deck","counterparty_name":"张总","counterparty_email":"","due_iso":null,"quote":"send the deck"}],"decisions_pending":[]}',
  stopReason: 'end',
}));

mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: () => true,
  chat,
}));

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  chat.mockClear();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('default', 'default', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

function gmailLoop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: 'thread:18c4a:unanswered_inbound',
    loopType: 'unanswered_inbound',
    summary: 'Reply owed to bob@example.com: "Plan"',
    evidence: [{ message_id: 'm1', quote: 'Can you review?', lane: 'google' }],
    threadId: '18c4a',
    detector: 'deterministic_thread',
    ...over,
  };
}

describe('closeThreadLoops lane isolation', () => {
  test('Gmail close does not close meeting:<id> even on the same source/detector', async () => {
    await upsertOpenLoop(engine, gmailLoop());
    await upsertOpenLoop(
      engine,
      gmailLoop({
        dedupKey: 'thread:meeting:4421:unanswered_inbound',
        threadId: 'meeting:4421',
        summary: 'Meeting follow-up',
        evidence: [{ page_slug: 'meetings/sync', quote: 'please follow up', lane: 'meeting' }],
      }),
    );
    const n = await closeThreadLoops(
      engine,
      'g1',
      'meeting:4421',
      'reply_detected',
      ['unanswered_inbound'],
      'google',
    );
    expect(n).toBe(0);
    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open.map((l) => l.thread_id).sort()).toEqual(['18c4a', 'meeting:4421']);
  });

  test('Gmail close DOES close google-lane array evidence (not {lane, items})', async () => {
    const { id } = await upsertOpenLoop(engine, gmailLoop());
    const before = await listOpenLoops(engine, { sourceIds: ['g1'] });
    expect(Array.isArray(before[0].evidence)).toBe(true);
    expect(before[0].evidence[0]).toMatchObject({
      quote: 'Can you review?',
      message_id: 'm1',
      lane: 'google',
    });
    expect(Array.isArray(before[0].evidence) && !('items' in (before[0].evidence as object))).toBe(true);

    const n = await closeThreadLoops(
      engine,
      'g1',
      '18c4a',
      'reply_detected',
      ['unanswered_inbound'],
      'google',
    );
    expect(n).toBe(1);
    const open = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'open' });
    expect(open.find((l) => l.id === id)).toBeUndefined();
    const done = await listOpenLoops(engine, { sourceIds: ['g1'], status: 'done' });
    expect(done[0].id).toBe(id);
    expect(Array.isArray(done[0].evidence)).toBe(true);
    expect(done[0].evidence[0].lane).toBe('google');
  });
});

describe('counterparties', () => {
  test('unmatched 张总 does not persist a fallback_slugify slug', async () => {
    const slug = await resolveLoopCounterpartySlug(engine, 'default', '张总');
    expect(slug).toBeNull();
  });
});

describe('meeting LLM key default OFF', () => {
  test('scanMeetingPages makes zero model calls when meeting extraction is OFF', async () => {
    await engine.putPage(
      'meetings/standup',
      {
        title: '与张总对齐',
        type: 'meeting',
        compiled_truth: 'TODO: 我会把方案发给张总。Action item: follow up.',
        frontmatter: { attendees: ['张总'] },
      },
      { sourceId: 'default' },
    );
    const r = await scanMeetingPages(engine, { sourceId: 'default' });
    expect(chat).not.toHaveBeenCalled();
    expect(r.model_calls).toBe(0);
    expect(r.scanned).toBe(1);
    const open = await listOpenLoops(engine, { sourceIds: ['default'], status: 'open' });
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]!.thread_id!.startsWith('meeting:')).toBe(true);
    expect(open[0]!.evidence[0].lane).toBe('meeting');
    expect(open[0]!.counterparty_slug).toBeNull();
  });

  test('mute sender=slug:default:people/zhang blocks new meeting loops for that person', async () => {
    await engine.putPage(
      'people/zhang',
      { title: '张', type: 'person', compiled_truth: 'Zhang, a counterpart.' },
      { sourceId: 'default' },
    );
    await addSuppression(engine, 'default', 'sender', 'slug:default:people/zhang');
    await engine.putPage(
      'meetings/blocked',
      {
        title: 'Sync',
        type: 'meeting',
        compiled_truth: 'TODO: follow up with Zhang.\nAction item: send notes.',
        frontmatter: { attendees: ['people/zhang'] },
      },
      { sourceId: 'default' },
    );
    await scanMeetingPages(engine, { sourceId: 'default' });
    const open = await listOpenLoops(engine, { sourceIds: ['default'], status: 'open' });
    expect(open).toHaveLength(0);
  });
});

describe('google-kind extract_facts skip', () => {
  test('runFactsBackstop skips google-kind email pages', async () => {
    const body = 'This is a long enough email body that facts eligibility will pass the length gate. '.repeat(3);
    const r = await runFactsBackstop(
      {
        slug: 'emails/thread-1',
        type: 'email',
        compiled_truth: body,
        frontmatter: { thread_id: '18c4a' },
      },
      {
        engine,
        sourceId: 'g1',
        sessionId: null,
        source: 'sync:import',
        mode: 'inline',
      },
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('google_source_email');
  });
});
