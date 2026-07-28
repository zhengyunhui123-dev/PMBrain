import { describe, expect, test } from 'bun:test';
import { listDesktopProviderModels } from '../src/main/model-catalog.js';
import { getRecipe } from '../../src/core/ai/recipes/index.js';

describe('desktop provider model catalog', () => {
  test('returns provider-scoped known models', async () => {
    const result = await listDesktopProviderModels('zhipu', 'embedding');
    expect(result.models).toEqual(getRecipe('zhipu')!.touchpoints.embedding!.models);
    expect(result.source).toBe('catalog');
  });

  test('uses the CLI recipe registry as the single cloud model source', async () => {
    for (const provider of ['mimo', 'zhipu', 'deepseek', 'openai', 'anthropic', 'google', 'openrouter']) {
      const result = await listDesktopProviderModels(provider, 'chat');
      expect(result.models).toEqual(getRecipe(provider)!.touchpoints.chat!.models);
    }
  });

  test('shows only installed Ollama models that match the requested capability', async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/api/tags')) {
        return new Response(JSON.stringify({
          models: [{ name: 'qwen3.6:latest' }, { model: 'qwen3-embedding:0.6b' }],
        }));
      }
      expect(value).toEndWith('/api/show');
      const model = JSON.parse(String(init?.body)).model;
      return new Response(JSON.stringify({
        capabilities: model === 'qwen3.6:latest'
          ? ['completion', 'tools']
          : ['embedding'],
      }));
    }) as typeof fetch;

    const chat = await listDesktopProviderModels('ollama', 'chat', fakeFetch);
    const embedding = await listDesktopProviderModels('ollama', 'embedding', fakeFetch);

    expect(chat).toEqual({ models: ['qwen3.6:latest'], source: 'ollama' });
    expect(embedding).toEqual({ models: ['qwen3-embedding:0.6b'], source: 'ollama' });
  });

  test('does not show uninstalled catalog models when Ollama is offline', async () => {
    const fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const result = await listDesktopProviderModels('ollama', 'embedding', fakeFetch);
    expect(result.models).toEqual([]);
    expect(result.source).toBe('ollama');
    expect(result.warning).toContain('未连接到本机 Ollama');
  });

  test('keeps Ollama chat editable when the local service is offline', async () => {
    const fakeFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const result = await listDesktopProviderModels('ollama', 'chat', fakeFetch);
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('无法读取已安装的普通模型');
  });

  test('explains an empty local Ollama chat catalog', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ models: [] }))) as typeof fetch;
    const result = await listDesktopProviderModels('ollama', 'chat', fakeFetch);
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('没有已安装的普通模型');
  });

  test('hides installed models whose Ollama capabilities cannot be confirmed', async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'unknown:latest' }] }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    const result = await listDesktopProviderModels('ollama', 'embedding', fakeFetch);
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('无法确认能力');
  });
});
