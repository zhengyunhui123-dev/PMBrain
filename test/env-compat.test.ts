import { describe, expect, test } from 'bun:test';
import { readCompatEnv } from '../src/core/env-compat.ts';

describe('PMBrain environment compatibility', () => {
  test('prefers PMBRAIN and falls back to legacy GBRAIN', () => {
    expect(readCompatEnv('PMBRAIN_SAMPLE', 'GBRAIN_SAMPLE', { PMBRAIN_SAMPLE: 'new', GBRAIN_SAMPLE: 'old' })).toBe('new');
    expect(readCompatEnv('PMBRAIN_SAMPLE', 'GBRAIN_SAMPLE', { GBRAIN_SAMPLE: 'old' })).toBe('old');
  });
});
