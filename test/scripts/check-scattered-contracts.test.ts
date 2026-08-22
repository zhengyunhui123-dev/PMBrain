import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectScatteredContractFailures,
  extractFunctionArity,
  extractKnobsHashVersion,
} from '../../scripts/check-scattered-contracts.ts';

describe('scattered retrieval contract checker', () => {
  test('reads the exported KNOBS_HASH_VERSION literal', () => {
    expect(extractKnobsHashVersion('export const KNOBS_HASH_VERSION = 10;\n')).toBe(10);
  });

  test('counts optional TypeScript parameters and ignores a trailing comma', () => {
    expect(extractFunctionArity(
      'export function buildVisibilityClause(\n  a: string,\n  b: string,\n  opts?: { excludePrivate?: boolean },\n): string { return a; }\n',
      'buildVisibilityClause',
    )).toBe(3);
  });

  test('fails leftover toBe() pins that were not updated with the source constant', () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-scattered-'));
    mkdirSync(join(root, 'src', 'core', 'search'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'search', 'mode.ts'), 'export const KNOBS_HASH_VERSION = 10;\n');
    writeFileSync(
      join(root, 'src', 'core', 'search', 'sql-ranking.ts'),
      'export function buildVisibilityClause(a: string, b: string, opts?: { excludePrivate?: boolean }) { return a + b + String(opts); }\n',
    );
    writeFileSync(
      join(root, 'test', 'stale-knobs.test.ts'),
      "expect(KNOBS_HASH_VERSION).toBe(9);\nexpect(buildVisibilityClause.length).toBe(2);\n",
    );

    const failures = collectScatteredContractFailures(root);
    expect(failures.some(line => line.includes('KNOBS_HASH_VERSION') && line.includes('9') && line.includes('10'))).toBe(true);
    expect(failures.some(line => line.includes('buildVisibilityClause.length') && line.includes('2'))).toBe(true);
  });

  test('current repository retrieval contract pins match the source', () => {
    expect(collectScatteredContractFailures(join(import.meta.dir, '../..'))).toEqual([]);
  });
});
