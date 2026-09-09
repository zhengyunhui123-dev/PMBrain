import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePgliteToastError } from '../src/core/pglite-errors.ts';
import { classifyPgliteInitError } from '../src/core/pglite-engine.ts';
import {
  assertStagingNotProduction,
  classifyToastColumn,
  recommendedActionFor,
  toastDiagnoseCanAutoRepair,
} from '../src/core/pglite-toast-repair.ts';

describe('parsePgliteToastError', () => {
  test('parses the live 191139 / pg_toast_16852 signature', () => {
    const parsed = parsePgliteToastError(
      'unexpected chunk number 3 (expected 0) for toast value 191139 in pg_toast_16852',
    );
    expect(parsed).toEqual({
      actualChunk: 3,
      expectedChunk: 0,
      toastValue: 191139,
      toastRelation: 'pg_toast_16852',
      heapOid: 16852,
    });
  });

  test('parses missing-chunk signature', () => {
    const parsed = parsePgliteToastError('missing chunk number 0 for toast value 12 in pg_toast_1');
    expect(parsed).toEqual({
      actualChunk: null,
      expectedChunk: 0,
      toastValue: 12,
      toastRelation: 'pg_toast_1',
      heapOid: 1,
    });
  });
});

describe('toast repair classification', () => {
  test('startup classifier no longer maps toast to wasm-abort', () => {
    expect(classifyPgliteInitError(
      'unexpected chunk number 3 (expected 0) for toast value 191139 in pg_toast_16852',
      'win32',
    )).toBe('toast-corrupt');
  });

  test('compiled_truth is canonical page content, not a derived field to blank', () => {
    expect(classifyToastColumn('pages', 'compiled_truth')).toBe('canonical-page');
    expect(recommendedActionFor('canonical-page', 'pages', 'compiled_truth')).toContain('禁止直接删除');
  });

  test('chunk text is rebuildable from the page', () => {
    expect(classifyToastColumn('content_chunks', 'chunk_text')).toBe('rebuildable-chunk');
  });

  test('orphan chunk repair is the recommended class for missing pages', () => {
    expect(recommendedActionFor('rebuildable-chunk', 'content_chunks', 'chunk_text')).toContain('不重建全库向量');
  });

  test('auto-repair is allowed for content_chunks and refused for page body', () => {
    expect(toastDiagnoseCanAutoRepair({
      status: 'located',
      baseTable: { schema: 'public', name: 'content_chunks', oid: 1, toastRelation: 'pg_toast_1', toastOid: 2 },
      repairability: 'rebuildable-chunk',
    })).toBe(true);
    expect(toastDiagnoseCanAutoRepair({
      status: 'located',
      baseTable: { schema: 'public', name: 'pages', oid: 1, toastRelation: 'pg_toast_1', toastOid: 2 },
      repairability: 'canonical-page',
    })).toBe(false);
  });

  test('search_vector and embeddings are derived', () => {
    expect(classifyToastColumn('pages', 'search_vector')).toBe('derived');
    expect(classifyToastColumn('content_chunks', 'embedding')).toBe('derived');
    expect(classifyToastColumn('facts', 'embedding')).toBe('derived');
  });

  test('facts body is not auto-deleted', () => {
    expect(classifyToastColumn('facts', 'fact')).toBe('fact');
  });

  test('refuses to use the production path as staging', () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-toast-guard-'));
    const production = join(root, 'brain.pglite');
    mkdirSync(production);
    writeFileSync(join(production, 'PG_VERSION'), '17\n');
    expect(() => assertStagingNotProduction(production, production)).toThrow(/production PGLite path/);
    expect(() => assertStagingNotProduction(join(root, 'copy', 'brain.pglite'), production)).not.toThrow();
  });
});

describe('repair CLI wiring', () => {
  test('cli.ts registers repair as a host-only command', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toContain("'repair'");
    expect(src).toContain("command === 'repair'");
    expect(src).toContain('runRepairCli');
    const command = readFileSync('src/commands/repair.ts', 'utf8');
    expect(command).toContain('toast-replace');
    expect(command).toContain('replaceProductionWithStaging');
  });

  test('engine WAL repair stays on wasm-abort only', () => {
    const src = readFileSync('src/core/pglite-engine.ts', 'utf8');
    expect(src).toContain("return 'toast-corrupt'");
    expect(src).toContain("if (verdict === 'wasm-abort')");
    expect(src).not.toMatch(/if \(verdict === 'toast-corrupt'\)[\s\S]{0,200}attemptWalRepairAndRetry/);
  });
});
