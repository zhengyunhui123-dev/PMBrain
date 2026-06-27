import { describe, expect, test } from 'bun:test';
import {
  formatUsdLimit,
  isValidSpendPosture,
  normalizeSpendPosture,
  parseUsdLimit,
  resolveSpendPosture,
  usdLimitToCap,
} from '../src/core/spend-posture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('spend posture', () => {
  test('normalizes tokenmax and defaults everything else to gated', () => {
    expect(normalizeSpendPosture('tokenmax')).toBe('tokenmax');
    expect(normalizeSpendPosture(' TOKENMAX ')).toBe('tokenmax');
    expect(normalizeSpendPosture('gated')).toBe('gated');
    expect(normalizeSpendPosture('max')).toBe('gated');
    expect(normalizeSpendPosture(null)).toBe('gated');
  });

  test('validates explicit config values', () => {
    expect(isValidSpendPosture('gated')).toBe(true);
    expect(isValidSpendPosture('tokenmax')).toBe(true);
    expect(isValidSpendPosture('TOKENMAX')).toBe(true);
    expect(isValidSpendPosture('max')).toBe(false);
    expect(isValidSpendPosture(undefined)).toBe(false);
  });

  test('resolves from engine config and fails closed to gated', async () => {
    const tokenmaxEngine = { getConfig: async () => 'tokenmax' } as unknown as BrainEngine;
    const brokenEngine = { getConfig: async () => { throw new Error('boom'); } } as unknown as BrainEngine;

    expect(await resolveSpendPosture(tokenmaxEngine)).toBe('tokenmax');
    expect(await resolveSpendPosture(brokenEngine)).toBe('gated');
  });
});

describe('USD limit parsing', () => {
  test('parses finite values and rejects invalid values to default', () => {
    expect(parseUsdLimit('3.5', 1)).toBe(3.5);
    expect(parseUsdLimit(2, 1)).toBe(2);
    expect(parseUsdLimit('-1', 1)).toBe(1);
    expect(parseUsdLimit('oops', 1)).toBe(1);
  });

  test('off tokens map to Infinity and render as unlimited', () => {
    const parsed = parseUsdLimit('off', 1);
    expect(parsed).toBe(Infinity);
    expect(formatUsdLimit(parsed)).toBe('unlimited');
    expect(usdLimitToCap(parsed)).toBeUndefined();
  });

  test('zero is opt-in per knob', () => {
    expect(parseUsdLimit('0', 5)).toBe(5);
    expect(parseUsdLimit('0', 5, { allowZero: true })).toBe(0);
  });
});
