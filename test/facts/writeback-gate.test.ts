import { describe, expect, test } from 'bun:test';
import {
  gateWritebackTurn,
  MIN_TURN_CHARS,
  MIN_TURN_CHARS_CJK,
  MAX_TURN_CHARS,
} from '../../src/core/facts/writeback-gate.ts';

describe('Stop Hook 预过滤：寒暄和问句不入库', () => {
  test('空内容和 Thanks 都不进银行', () => {
    expect(gateWritebackTurn('')).toEqual({ ok: false, reason: 'empty' });
    expect(gateWritebackTurn('Thanks')).toEqual({ ok: false, reason: 'too_short' });
  });

  test('够长的纯确认语跳过', () => {
    expect(gateWritebackTurn('okay sounds good thanks so much!')).toEqual({ ok: false, reason: 'ack_or_greeting' });
  });

  test('中文过敏事实能过门槛，短句不行', () => {
    expect(gateWritebackTurn('我对花生过敏').ok).toBe(false);
    expect(gateWritebackTurn('我对花生严重过敏，随身带肾上腺素笔').ok).toBe(true);
    expect(MIN_TURN_CHARS_CJK).toBeLessThan(MIN_TURN_CHARS);
  });

  test('纯问句跳过，事实加问句可以通过', () => {
    expect(gateWritebackTurn('What time is the standup tomorrow? Can you check the calendar?')).toEqual({ ok: false, reason: 'question_only' });
    expect(gateWritebackTurn('I moved the standup to 9am. Can you update the calendar?').ok).toBe(true);
  });

  test('粘贴超过上限跳过', () => {
    const big = 'a decision was made. '.repeat(500);
    expect(big.length).toBeGreaterThan(MAX_TURN_CHARS);
    expect(gateWritebackTurn(big)).toEqual({ ok: false, reason: 'bulk_paste' });
  });
});
