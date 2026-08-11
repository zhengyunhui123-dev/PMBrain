import { describe, expect, test } from 'bun:test';
import { applyMcpQueryDefaults, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';

describe('MCP query expansion default', () => {
  test('remote MCP query defaults expand to false when omitted', () => {
    expect(applyMcpQueryDefaults('query', { query: '简单问题' }, true)).toEqual({
      query: '简单问题',
      expand: false,
    });
  });

  test('remote MCP query preserves an explicit expand=true decision', () => {
    expect(applyMcpQueryDefaults('query', { query: '模糊问题', expand: true }, true)).toEqual({
      query: '模糊问题',
      expand: true,
    });
  });

  test('local operation dispatch keeps the existing query default', () => {
    expect(applyMcpQueryDefaults('query', { query: '本地 CLI 问题' }, false)).toEqual({
      query: '本地 CLI 问题',
    });
  });

  test('does not add query defaults to other MCP tools', () => {
    expect(applyMcpQueryDefaults('search', { query: '关键词' }, true)).toEqual({
      query: '关键词',
    });
  });

  test('does not mutate the caller arguments when applying the MCP default', () => {
    const input = { query: '简单问题' };
    const normalized = applyMcpQueryDefaults('query', input, true);

    expect(input).toEqual({ query: '简单问题' });
    expect(normalized).not.toBe(input);
  });

  test('shared MCP dispatcher sends the normalized default to the query operation', async () => {
    const queryOp = operations.find(operation => operation.name === 'query')!;
    const originalHandler = queryOp.handler;
    let receivedParams: Record<string, unknown> | undefined;

    queryOp.handler = async (_ctx, params) => {
      receivedParams = params;
      return [];
    };

    try {
      const result = await dispatchToolCall(
        {} as never,
        'query',
        { query: '简单问题' },
        { remote: true },
      );
      expect(result.isError).toBeUndefined();
      expect(receivedParams).toEqual({ query: '简单问题', expand: false });
    } finally {
      queryOp.handler = originalHandler;
    }
  });
});
