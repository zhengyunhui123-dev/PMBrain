import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bankWritebackTurn, parseWritebackSourceId, writebackFileName } from '../../src/core/facts/writeback-bank.ts';
import { HOOK_WRITEBACK_PROVENANCE } from '../../src/core/facts/writeback-config.ts';

describe('Hook 银行文件带着真实 Source', () => {
  test('没有合法 Source 就跳过，不发明 hook:writeback Source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bank-'));
    expect(bankWritebackTurn({
      dir,
      sessionId: 'sess',
      normalizedTurn: '以后封面图默认 2.35:1',
      hash24: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      sourceId: null,
    }).status).toBe('wb_no_source');
    expect(HOOK_WRITEBACK_PROVENANCE).not.toBe('hook:writeback');
  });

  test('文件名带上当前 Source，可以再解析回来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-bank-'));
    const result = bankWritebackTurn({
      dir,
      sessionId: 'sess',
      normalizedTurn: '以后封面图默认 2.35:1',
      hash24: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      sourceId: 'default',
    });
    expect(result.status).toBe('wb_banked');
    expect(result.fileName).toBe(writebackFileName('sess', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'default'));
    expect(parseWritebackSourceId(result.fileName!)).toBe('default');
    expect(readFileSync(join(dir, result.fileName!), 'utf8')).toContain('2.35:1');
  });
});
