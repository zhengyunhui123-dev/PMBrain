import { describe, expect, test } from 'bun:test';
import {
  classifyErrorCode,
  isInfrastructureFailureCode,
} from '../src/core/sync-failure-ledger.ts';
import {
  isGinCorruptionError,
  PGLITE_GIN_INDEX_NAMES,
  repairPgliteGinIndexes,
} from '../src/core/pglite-gin-repair.ts';

describe('PGLite GIN corruption handling', () => {
  test('classifies the Windows GIN sibling error as infrastructure', () => {
    const msg = 'right sibling of GIN page is of different type';
    expect(isGinCorruptionError(new Error(msg))).toBe(true);
    expect(classifyErrorCode(msg)).toBe('DB_INDEX_CORRUPT');
    expect(isInfrastructureFailureCode('DB_INDEX_CORRUPT')).toBe(true);
    expect(isInfrastructureFailureCode('UNKNOWN')).toBe(false);
  });

  test('rebuilds known GIN indexes once through executeRaw', async () => {
    const sql: string[] = [];
    const repaired = await repairPgliteGinIndexes({
      executeRaw: async (statement: string) => {
        sql.push(statement);
      },
    });
    expect(repaired).toBe(PGLITE_GIN_INDEX_NAMES.length);
    expect(sql).toEqual(PGLITE_GIN_INDEX_NAMES.map(name => `REINDEX INDEX ${name}`));
  });

  test('quick catch-up keeps JSON progress when --progress-json is set', async () => {
    const cycle = await Bun.file(new URL('../src/core/cycle.ts', import.meta.url)).text();
    expect(cycle).toContain('quiet: !getCliOptions().progressJson');
    const importSource = await Bun.file(new URL('../src/commands/import.ts', import.meta.url)).text();
    expect(importSource).toContain('repairPgliteGinIndexes');
    const staleSource = await Bun.file(new URL('../src/commands/extract-stale.ts', import.meta.url)).text();
    expect(staleSource).toContain('repairPgliteGinIndexes');
  });
});
