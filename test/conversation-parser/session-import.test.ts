import { expect, test } from 'bun:test';
import { parseSessionExport } from '../../src/core/conversation-parser/session-import.ts';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');

test('Codex selects typed Chinese turns and excludes injected context and tools', () => {
  const result = parseSessionExport(jsonl([
    { type: 'session_meta', payload: { id: 'session-a' } },
    { type: 'event_msg', timestamp: '2026-09-07T10:00:00Z', payload: { type: 'user_message', message: '并未批准，只考虑试点。' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'INJECTED' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'SECRET TOOL OUTPUT' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '保留为待讨论事项。' }] } },
  ]), 'rollout.jsonl');
  expect(result.format).toBe('codex');
  expect(result.sessionId).toBe('session-a');
  expect(result.messages.map(m => m.text)).toEqual(['并未批准，只考虑试点。', '保留为待讨论事项。']);
  expect(result.messages[0].timestamp).toBe('2026-09-07T10:00:00.000Z');
});

test('Grok retains typed content without inventing timestamps', () => {
  const result = parseSessionExport(jsonl([
    { type: 'system', content: '系统提示' },
    { type: 'user', content: [{ type: 'text', text: '请整理会议。' }] },
    { type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: 'INJECTED' }] },
    { type: 'assistant', content: '', tool_calls: [{ id: 'tool' }] },
    { type: 'assistant', content: '预算尚未确定。' },
  ]), 'chat_history.jsonl');
  expect(result.messages.map(m => m.text)).toEqual(['请整理会议。', '预算尚未确定。']);
  expect(result.messages.every(m => m.timestamp === null)).toBe(true);
});

test.each(['{"foo":"bar"}', '{broken', '{"type":"user","content":42}'])('rejects unsupported or broken exports without importing raw JSON: %s', text => {
  expect(() => parseSessionExport(text, 'unknown.jsonl')).toThrow();
});

test('a malformed human message is an error rather than a successful partial import', () => {
  expect(() => parseSessionExport(jsonl([
    { type: 'session_meta', payload: { id: 'a' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 42 } },
  ]), 'rollout.jsonl')).toThrow();
});
