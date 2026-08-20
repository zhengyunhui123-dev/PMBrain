import { afterEach, describe, expect, test } from 'bun:test';
import { testModelConnection } from '../src/main/model-connection-test.js';

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startOpenAICompatServer(options: {
  chatStatus?: number;
  chatBody?: unknown;
  embedding?: number[];
} = {}): { baseUrl: string; requests: Array<{ path: string; body: any; authorization: string }> } {
  const requests: Array<{ path: string; body: any; authorization: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const rawBody = await request.text();
      const body = rawBody ? JSON.parse(rawBody) : null;
      requests.push({
        path: url.pathname,
        body,
        authorization: request.headers.get('authorization') ?? '',
      });
      if (url.pathname.endsWith('/chat/completions')) {
        const status = options.chatStatus ?? 200;
        return Response.json(
          options.chatBody ?? {
            id: 'chat-test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          },
          { status },
        );
      }
      if (url.pathname.endsWith('/embeddings')) {
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: options.embedding ?? [0.1, 0.2, 0.3] }],
          model: 'draft-embedding',
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `${server.url.toString().replace(/\/$/, '')}/v1`, requests };
}

describe('desktop model connection test', () => {
  test('sends the current ordinary-model draft and reports a successful connection', async () => {
    const fixture = startOpenAICompatServer();
    const result = await testModelConnection({
      provider: 'custom-openai',
      baseUrl: fixture.baseUrl,
      model: 'draft-chat',
      apiKey: 'draft-key',
      touchpoint: 'chat',
    });

    expect(result.status).toBe('success');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(fixture.requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      authorization: 'Bearer draft-key',
    });
    expect(fixture.requests[0]?.body.model).toBe('draft-chat');
    expect(fixture.requests[0]?.body.messages.at(-1).content).toContain('OK');
  });

  test('sends the fixed embedding probe and reports the actual vector width', async () => {
    const fixture = startOpenAICompatServer({ embedding: [0.1, 0.2, 0.3, 0.4] });
    const result = await testModelConnection({
      provider: 'custom-openai',
      baseUrl: fixture.baseUrl,
      model: 'draft-embedding',
      apiKey: 'embedding-key',
      touchpoint: 'embedding',
    });

    expect(result.status).toBe('success');
    expect(result.dimensions).toBe(4);
    expect(fixture.requests[0]).toMatchObject({
      path: '/v1/embeddings',
      authorization: 'Bearer embedding-key',
    });
    expect(fixture.requests[0]?.body.input).toEqual(['PMBrain embedding test']);
  });

  test('keeps the provider error body visible for an invalid API key', async () => {
    const fixture = startOpenAICompatServer({
      chatStatus: 401,
      chatBody: { error: { message: 'Invalid API key for this model' } },
    });
    const result = await testModelConnection({
      provider: 'custom-openai',
      baseUrl: fixture.baseUrl,
      model: 'draft-chat',
      apiKey: 'bad-key',
      touchpoint: 'chat',
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('401');
    expect(result.message).toContain('Invalid API key for this model');
  });

  test('warns when the configured embedding width differs from the provider response', async () => {
    const fixture = startOpenAICompatServer({ embedding: [0.1, 0.2, 0.3] });
    const result = await testModelConnection({
      provider: 'custom-openai',
      baseUrl: fixture.baseUrl,
      model: 'draft-embedding',
      apiKey: 'embedding-key',
      expectedDimensions: 4,
      touchpoint: 'embedding',
    });

    expect(result.status).toBe('warning');
    expect(result.dimensions).toBe(3);
    expect(result.message).toContain('配置 4 维');
    expect(result.message).toContain('实际返回 3 维');
  });
});
