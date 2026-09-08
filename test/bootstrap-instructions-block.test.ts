import { describe, expect, test } from 'bun:test';
import {
  AMBIENT_WRITEBACK_BLOCK_BEGIN,
  AMBIENT_WRITEBACK_BLOCK_END,
  probeAmbientBlock,
  removeAmbientWritebackBlock,
  renderAmbientInstructionBlock,
  spliceAmbientWritebackBlock,
} from '../src/core/bootstrap/instructions-block.ts';

describe('托管 AGENTS/CLAUDE 区块', () => {
  test('Windows 换行仍识别区块，重复接入不增加副本', () => {
    const original = `保留用户内容\r\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\r\nold\r\n${AMBIENT_WRITEBACK_BLOCK_END}\r\n尾部\r\n`;
    expect(probeAmbientBlock(original).state).toBe('present');
    const next = spliceAmbientWritebackBlock(original, 'new');
    expect(next.split(AMBIENT_WRITEBACK_BLOCK_BEGIN)).toHaveLength(2);
    expect(removeAmbientWritebackBlock(next).text).toBe('保留用户内容\r\n尾部\r\n');
  });
  test('只维护标记区块，不覆盖用户原文', () => {
    const existing = '# my notes\nkeep this\n';
    const body = renderAmbientInstructionBlock({
      mode: 'salient',
      transientTtl: '3d',
      visibility: 'world',
      serveUrl: 'http://127.0.0.1:3210/mcp',
    });
    const spliced = spliceAmbientWritebackBlock(existing, body);
    expect(spliced.startsWith('# my notes')).toBe(true);
    expect(spliced).toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
    expect(spliced).toContain('mode: salient');
    const again = spliceAmbientWritebackBlock(spliced, body);
    expect(again.split(AMBIENT_WRITEBACK_BLOCK_BEGIN).length).toBe(2);
  });

  test('关闭时去掉区块，文件还在', () => {
    const spliced = spliceAmbientWritebackBlock('keep\n', 'body');
    const { text, removed } = removeAmbientWritebackBlock(spliced);
    expect(removed).toBe(true);
    expect(text).toContain('keep');
    expect(text).not.toContain(AMBIENT_WRITEBACK_BLOCK_END);
  });

  test('损坏标记要报错，不能猜着改', () => {
    expect(probeAmbientBlock(`${AMBIENT_WRITEBACK_BLOCK_BEGIN}\nno end`).state).toBe('damaged');
  });
});
