import { describe, expect, test } from 'bun:test';
import {
  repairToolPairing,
  toModelMessages,
  type ChatMessage,
} from '../src/core/ai/gateway.ts';

describe('toModelMessages — AI SDK v6 transcript compatibility', () => {
  test('converts tool results to the dedicated tool role', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'find widget' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { query: 'widget' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { hits: 1 } },
        ],
      },
    ];

    expect(toModelMessages(messages)).toEqual([
      { role: 'user', content: 'find widget' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { query: 'widget' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: { type: 'json', value: { hits: 1 } },
          },
        ],
      },
    ]);
  });

  test('deep-normalizes Date and undefined values in PostgreSQL tool output', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'get_page',
            output: {
              updated_at: new Date('2026-07-28T01:02:03.000Z'),
              optional: undefined,
              nested: [{ effective_date: new Date('2026-07-27T00:00:00.000Z') }],
            },
          },
        ],
      },
    ];

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'get_page',
            output: {
              type: 'json',
              value: {
                updated_at: '2026-07-28T01:02:03.000Z',
                nested: [{ effective_date: '2026-07-27T00:00:00.000Z' }],
              },
            },
          },
        ],
      },
    ]);
  });

  test('serializes error output and preserves null JSON output', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { message: 'boom' }, isError: true },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'noop', output: null },
        ],
      },
    ];

    expect(toModelMessages(messages)).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: { type: 'error-text', value: '{"message":"boom"}' },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'noop',
            output: { type: 'json', value: null },
          },
        ],
      },
    ]);
  });
});

describe('repairToolPairing', () => {
  test('adds a recoverable error result for an interrupted tool call', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'find widget' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { query: 'widget' } },
        ],
      },
    ];

    expect(repairToolPairing(messages)).toEqual([
      messages[0],
      messages[1],
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: 'tool result unavailable (recovered after interrupted run)',
            isError: true,
          },
        ],
      },
    ]);
  });

  test('merges a missing sibling into a partial tool-result turn', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: {} },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'get_page', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: [] },
        ],
      },
    ];

    const repaired = repairToolPairing(messages);
    expect(repaired).toHaveLength(2);
    expect((repaired[1]!.content as unknown[])).toHaveLength(2);
    expect((repaired[1]!.content as Array<{ toolCallId: string }>)[1]!.toolCallId).toBe('c2');
  });
});
