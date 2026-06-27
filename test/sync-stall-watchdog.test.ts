import { describe, expect, test } from 'bun:test';
import {
  composeAbortSignals,
  DEFAULT_SYNC_STALL_ABORT_SEC,
  resolveStallAbortSeconds,
} from '../src/commands/sync.ts';

describe('resolveStallAbortSeconds', () => {
  test('defaults to 900s when unset or empty', () => {
    expect(resolveStallAbortSeconds({})).toBe(DEFAULT_SYNC_STALL_ABORT_SEC);
    expect(resolveStallAbortSeconds({ PMBRAIN_SYNC_STALL_ABORT_SECONDS: '' })).toBe(900);
  });

  test('PMBRAIN env wins over GBRAIN compatibility env', () => {
    expect(resolveStallAbortSeconds({
      PMBRAIN_SYNC_STALL_ABORT_SECONDS: '120',
      GBRAIN_SYNC_STALL_ABORT_SECONDS: '240',
    })).toBe(120);
  });

  test('GBRAIN env remains compatible when PMBRAIN env is absent', () => {
    expect(resolveStallAbortSeconds({ GBRAIN_SYNC_STALL_ABORT_SECONDS: '240' })).toBe(240);
  });

  test('non-positive values disable the watchdog', () => {
    expect(resolveStallAbortSeconds({ PMBRAIN_SYNC_STALL_ABORT_SECONDS: '0' })).toBe(0);
    expect(resolveStallAbortSeconds({ PMBRAIN_SYNC_STALL_ABORT_SECONDS: '-1' })).toBe(-1);
  });

  test('invalid values fall back to default', () => {
    expect(resolveStallAbortSeconds({ PMBRAIN_SYNC_STALL_ABORT_SECONDS: 'nope' })).toBe(900);
  });
});

describe('composeAbortSignals', () => {
  test('aborts when either signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const signal = composeAbortSignals(a.signal, b.signal);
    expect(signal.aborted).toBe(false);
    b.abort(new Error('secondary'));
    expect(signal.aborted).toBe(true);
  });

  test('returns the second signal when the first is absent', () => {
    const b = new AbortController();
    const signal = composeAbortSignals(undefined, b.signal);
    expect(signal).toBe(b.signal);
  });
});
