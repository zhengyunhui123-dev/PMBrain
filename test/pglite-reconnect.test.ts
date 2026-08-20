import { describe, expect, test } from 'bun:test';
import { DatabaseAlreadyOwnedError } from '../src/core/pglite-errors.ts';
import { reconnectPgliteWithRetry } from '../src/core/pglite-reconnect.ts';

function ownershipError(): DatabaseAlreadyOwnedError {
  return new DatabaseAlreadyOwnedError({
    databasePath: 'temporary-test-brain',
    lockPath: 'temporary-test-brain/.gbrain-lock/lock',
    ownerPid: 1234,
    ownerType: 'cli',
  });
}

describe('PGLite database handoff reconnect', () => {
  test('retries a short lock handoff and succeeds without user intervention', async () => {
    let attempts = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];

    await reconnectPgliteWithRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw ownershipError();
    }, {
      maxAttempts: 5,
      maxElapsedMs: 1_000,
      sleep: async () => undefined,
      onRetry: (_error, attempt, delayMs) => retries.push({ attempt, delayMs }),
    });

    expect(attempts).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
    ]);
  });

  test('does not hide a non-ownership database failure behind retries', async () => {
    const error = new Error('PGLite schema is corrupt');
    let attempts = 0;

    await expect(reconnectPgliteWithRetry(async () => {
      attempts += 1;
      throw error;
    }, { sleep: async () => undefined })).rejects.toBe(error);

    expect(attempts).toBe(1);
  });
});
