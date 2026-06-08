import { afterEach, describe, expect, test } from 'bun:test';
import { previewIntent } from '../src/commands/admin-console.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

describe('admin console intent planning', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setChatTransportForTests(null);
    resetGateway();
  });

  test('MIMO tool call arguments are accepted when message content is empty', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            type: 'function',
            function: {
              name: 'pmbrain_action',
              arguments: JSON.stringify({
                intent: 'import_path',
                path: 'D:\\Obsidian\\Vault\\raw\\a.md',
                includeOffice: true,
              }),
            },
          }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const preview = await previewIntent('导入这个md', {
      chat_model: 'mimo:mimo-v2.5-pro',
      mimo_api_key: 'test-key',
    } as any);

    expect(preview.intent).toBe('import_path');
    expect(preview.slots.path).toBe('D:\\Obsidian\\Vault\\raw\\a.md');
    expect(preview.slots.pathType).toBe('file');
  });

  test('gateway tool-call blocks are accepted when result text is empty', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'pmbrain_action',
        input: { intent: 'search_brain', query: '陆海新通道' },
      }],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'zhipu:glm-4.5',
      providerId: 'zhipu',
    }));

    const preview = await previewIntent('查一下陆海新通道项目资料', {
      chat_model: 'zhipu:glm-4.5',
      zhipu_api_key: 'test-key',
    } as any);

    expect(preview.intent).toBe('search_brain');
    expect(preview.slots.query).toBe('陆海新通道');
  });
});
