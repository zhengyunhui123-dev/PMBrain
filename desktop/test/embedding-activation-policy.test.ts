import { describe, expect, test } from 'bun:test';
import { requiresFirstActivationAlignment } from '../src/main/startup/embedding-activation-policy.ts';

describe('first embedding-model activation', () => {
  test('does not realign a fresh PGLite database created from the saved model config', () => {
    expect(requiresFirstActivationAlignment({
      engine: 'pglite',
      databaseExistedBeforeSave: false,
    })).toBe(false);
  });

  test('keeps empty-only alignment for an existing PGLite database', () => {
    expect(requiresFirstActivationAlignment({
      engine: 'pglite',
      databaseExistedBeforeSave: true,
    })).toBe(true);
  });

  test('does not change the existing Postgres activation flow', () => {
    expect(requiresFirstActivationAlignment({
      engine: 'postgres',
      databaseExistedBeforeSave: false,
    })).toBe(true);
  });
});
