import { describe, expect, test } from 'bun:test';
import { streamOllamaNativeChat } from '../../src/core/ai/ollama-native.ts';

describe('streamOllamaNativeChat thinking fallback', () => {
  test('promotes thinking text when content is empty', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response([
          JSON.stringify({ message: { role: 'assistant', content: '', thinking: '{"answer":"' }, done: false }),
          JSON.stringify({
            message: { role: 'assistant', content: '', thinking: 'ok","citations":[],"gaps":[]}' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 2,
            eval_count: 4,
          }),
        ].join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
      },
    });

    try {
      const result = await streamOllamaNativeChat({
        baseURL: `${server.url.toString().replace(/\/$/, '')}/v1`,
        model: 'qwen3:4b',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 128,
      });
      expect(result.text).toBe('{"answer":"ok","citations":[],"gaps":[]}');
    } finally {
      server.stop(true);
    }
  });

  test('keeps content when both content and thinking are present', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(JSON.stringify({
          message: { role: 'assistant', content: '{"answer":"visible"}', thinking: 'hidden' },
          done: true,
          done_reason: 'stop',
        }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
      },
    });

    try {
      const result = await streamOllamaNativeChat({
        baseURL: `${server.url.toString().replace(/\/$/, '')}/v1`,
        model: 'qwen3:4b',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 128,
      });
      expect(result.text).toBe('{"answer":"visible"}');
    } finally {
      server.stop(true);
    }
  });
});
