import { describe, expect, test } from 'bun:test';
import { requiresFirstActivationAlignment } from '../src/main/startup/embedding-activation-policy.ts';

describe('first embedding-model activation', () => {
  test('首次配置 PGLite 时也要对齐探测后的真实维度，避免导入完成却没有任何知识页', () => {
    expect(requiresFirstActivationAlignment({
      engine: 'pglite',
      databaseExistedBeforeSave: false,
    })).toBe(true);
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
