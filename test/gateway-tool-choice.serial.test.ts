import { afterEach, expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway, toolLoop, __setChatTransportForTests } from '../src/core/ai/gateway';

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
const tool = { name: 'edit_file', description: 'Edit a test file', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const usage = { input_tokens: 4, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 };

test('强制工具选项实际发送给服务商，未指定时沿用默认请求', async () => {
  const bodies: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    bodies.push(await request.json());
    return Response.json({ id: 'test', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'ack' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  } });
  try {
    configureGateway({ generative_enabled: true, chat_model: 'deepseek:deepseek-chat', env: { DEEPSEEK_API_KEY: 'test-key' }, base_urls: { deepseek: server.url.origin + '/v1' } });
    await chat({ messages: [{ role: 'user', content: 'edit' }], tools: [tool], toolChoice: 'required' });
    await chat({ messages: [{ role: 'user', content: 'normal' }], tools: [tool] });
    expect(bodies[0].tool_choice).toBe('required');
    expect(bodies[1].tool_choice).not.toBe('required');
  } finally { server.stop(true); }
});

test('工具循环逐轮选择执行约束，完成后可正常给出最终回答', async () => {
  configureGateway({ generative_enabled: true, chat_model: 'deepseek:deepseek-chat', env: { DEEPSEEK_API_KEY: 'test-key' } });
  let requests = 0; let executions = 0;
  __setChatTransportForTests(async options => {
    requests++;
    expect(options.toolChoice).toBe(requests === 1 ? 'required' : undefined);
    return requests === 1 ? { text: '', blocks: [{ type: 'tool-call', toolName: 'edit_file', toolCallId: 'edit', input: {} }], stopReason: 'tool_calls', usage, model: 'deepseek:deepseek-chat', providerId: 'deepseek' } : { text: 'done', blocks: [{ type: 'text', text: 'done' }], stopReason: 'end', usage, model: 'deepseek:deepseek-chat', providerId: 'deepseek' };
  });
  const result = await toolLoop({ initialMessages: [{ role: 'user', content: 'edit' }], tools: [tool], toolHandlers: new Map([['edit_file', { idempotent: false, execute: async () => { executions++; return { edited: true }; } }]]), maxTurns: 4, beforeModelCall: ({ turnIdx, messages }) => ({ messages: [...messages], toolChoice: turnIdx === 0 ? 'required' : undefined }) });
  expect(executions).toBe(1); expect(requests).toBe(2); expect(result.finalText).toBe('done');
});
