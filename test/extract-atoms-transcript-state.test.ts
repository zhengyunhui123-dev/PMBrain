import { expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  recordTranscriptFailureCount,
  stampTranscriptTombstone,
  tombstonedTranscriptsForHashes,
  transcriptStateKey,
} from '../src/core/cycle/extract-atoms-transcript-state.ts';

test('tombstoned transcripts are keyed by path and content hash', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await stampTranscriptTombstone(engine, 'default', 'meetings/a.txt', 'abcdef0123456789xxxx');
  const set = await tombstonedTranscriptsForHashes(engine, 'default', ['abcdef0123456789']);
  expect(set.has(transcriptStateKey('meetings/a.txt', 'abcdef0123456789'))).toBe(true);
  expect(set.has(transcriptStateKey('meetings/b.txt', 'abcdef0123456789'))).toBe(false);
  await engine.disconnect();
}, 60000);

test('transcript failure count increments until a later tombstone can fire', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
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
  await engine.disconnect();
}, 60000);
