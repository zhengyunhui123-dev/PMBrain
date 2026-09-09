import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  recordTranscriptFailureCount,
  stampTranscriptTombstone,
  tombstonedTranscriptsForHashes,
  transcriptStateKey,
} from '../src/core/cycle/extract-atoms-transcript-state.ts';

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
});

test('tombstoned transcripts are keyed by path and content hash', async () => {
  await stampTranscriptTombstone(engine, 'default', 'meetings/a.txt', 'abcdef0123456789xxxx');
  const set = await tombstonedTranscriptsForHashes(engine, 'default', ['abcdef0123456789']);
  expect(set.has(transcriptStateKey('meetings/a.txt', 'abcdef0123456789'))).toBe(true);
  expect(set.has(transcriptStateKey('meetings/b.txt', 'abcdef0123456789'))).toBe(false);
});

test('transcript failure count increments until a later tombstone can fire', async () => {
  const first = await recordTranscriptFailureCount(engine, 'default', 'meetings/a.txt', 'abcdef0123456789xxxx');
  const second = await recordTranscriptFailureCount(engine, 'default', 'meetings/a.txt', 'abcdef0123456789xxxx');
  const third = await recordTranscriptFailureCount(engine, 'default', 'meetings/a.txt', 'abcdef0123456789xxxx');
  expect(first).toBe(1);
  expect(second).toBe(2);
  expect(third).toBe(3);
  const before = await tombstonedTranscriptsForHashes(engine, 'default', ['abcdef0123456789']);
  expect(before.size).toBe(0);
  await stampTranscriptTombstone(engine, 'default', 'meetings/a.txt', 'abcdef0123456789xxxx');
  const after = await tombstonedTranscriptsForHashes(engine, 'default', ['abcdef0123456789']);
  expect(after.has(transcriptStateKey('meetings/a.txt', 'abcdef0123456789'))).toBe(true);
});
