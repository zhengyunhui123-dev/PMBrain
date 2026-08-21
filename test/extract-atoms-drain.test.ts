import { describe, expect, test } from 'bun:test';
import { runExtractAtomsDrain } from '../src/core/cycle/extract-atoms-drain.ts';

describe('extract-atoms drain product contract', () => {
  test('holds one lock and repeatedly drains bounded batches until backlog reaches zero', async () => {
    let remaining = 3;
    let lockCalls = 0;
    const result = await runExtractAtomsDrain({
      withLock: async work => { lockCalls++; return work(); },
      runBatch: async () => { remaining--; return { extracted: 1, skipped: 0 }; },
      countRemaining: async () => remaining,
      now: () => 0,
    }, { windowMs: 60_000 });

    expect(lockCalls).toBe(1);
    expect(result.extracted).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.stopped).toBe('drained');
  });

  test('zero progress stops immediately instead of spending in a hot loop', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain({
      withLock: work => work(),
      runBatch: async () => { batches++; return { extracted: 0, skipped: 0 }; },
      countRemaining: async () => 5,
      now: () => 0,
    }, { windowMs: 60_000 });

    expect(batches).toBe(1);
    expect(result.stopped).toBe('no_progress');
  });

  test('all provider calls failing is a retryable provider_failure, not success', async () => {
    const result = await runExtractAtomsDrain({
      withLock: work => work(),
      runBatch: async () => ({ extracted: 0, skipped: 0, providerFailure: true }),
      countRemaining: async () => 7,
      now: () => 0,
    }, { windowMs: 60_000 });

    expect(result.status).toBe('provider_failure');
    expect(result.stopped).toBe('provider_failure');
    expect(result.remaining).toBe(7);
  });
});
