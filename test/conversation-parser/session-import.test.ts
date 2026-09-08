import { expect, test } from 'bun:test';
import { parseSessionExport } from '../../src/core/conversation-parser/session-import.ts';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
const userText = { content_item_kinds: ['user.text'] };

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

test('Codex desktop user.text turns are imported while plugins, AGENTS and environment stay out', () => {
  const result = parseSessionExport(jsonl([
    { type: 'session_meta', payload: { id: 'desktop-session' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>' }] } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context'] },
      content: [{ type: 'input_text', text: '<recommended_plugins>' }],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: userText,
      content: [{ type: 'input_text', text: '这些修复了的就不要再改回去了。' }],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] },
      content: [{ type: 'input_text', text: '# AGENTS.md' }],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] },
      content: [{ type: 'input_text', text: '<environment_context>' }],
    } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '按这个约束继续。' }] } },
  ]), 'rollout.jsonl');
  expect(result.messages.map(m => m.text)).toEqual(['这些修复了的就不要再改回去了。', '按这个约束继续。']);
});

test('Codex dual-format copies of the same user turn are kept once', () => {
  const result = parseSessionExport(jsonl([
    { type: 'session_meta', payload: { id: 'dual' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '按建议执行吧' } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: userText,
      content: [{ type: 'input_text', text: '按建议执行吧\n' }],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: userText,
      content: [{ type: 'input_text', text: '那继续啊' }],
    } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续处理。' }] } },
  ]), 'rollout.jsonl');
  expect(result.messages.map(m => m.role + ':' + m.text.trim())).toEqual([
    'user:按建议执行吧',
    'user:那继续啊',
    'assistant:继续处理。',
  ]);
});

test('abnormal Codex user metadata is skipped instead of imported as a typed turn', () => {
  const result = parseSessionExport(jsonl([
    { type: 'session_meta', payload: { id: 'odd-meta' } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: 'user.text' },
      content: [{ type: 'input_text', text: '异常元数据不应导入' }],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text', 'plugins.recommendations'] },
      content: [{ type: 'input_text', text: '混合种类不应导入' }],
    } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: userText,
      content: [{ type: 'input_text', text: '这是用户原话。' }],
    } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已记录。' }] } },
  ]), 'rollout.jsonl');
  expect(result.messages.map(m => m.text)).toEqual(['这是用户原话。', '已记录。']);
});

test('a malformed desktop user.text body is an error rather than a successful partial import', () => {
  expect(() => parseSessionExport(jsonl([
    { type: 'session_meta', payload: { id: 'bad-desktop' } },
    { type: 'response_item', payload: {
      type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: userText,
      content: 42,
    } },
  ]), 'rollout.jsonl')).toThrow();
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
