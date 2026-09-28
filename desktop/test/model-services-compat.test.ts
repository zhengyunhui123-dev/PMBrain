import { expect, test } from 'bun:test';
import { hydrateModelServices, projectModelServices } from '../src/main/models/model-services';
import { syncServiceModels } from '../src/main/models/model-service-sync';
import { newServiceModel, serviceModelValue, type ModelService } from '../../shared/model-services';

const platform = (patch: Partial<ModelService> = {}): ModelService => ({ id: 'local', provider: 'service-local', name: '本地服务', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, models: [], ...patch });
test('upgrading separate custom chat and embedding preserves keys, addresses, selections and dimensions', () => {
  const config = { chat_model: 'custom-openai:local-chat', embedding_model: 'custom-openai:local-embed', embedding_dimensions: 768, provider_touchpoint_base_urls: { 'custom-openai': { chat: 'http://localhost:8000/v1', embedding: 'http://localhost:8001/v1' } }, provider_touchpoint_api_keys: { 'custom-openai': { chat: 'chat-secret', embedding: 'embed-secret' } } };
  const setup: any = { chatModel: config.chat_model, embeddingModel: config.embedding_model, embeddingDimensions: 768, keyValues: { customOpenaiChat: 'chat-secret', customOpenaiEmbedding: 'embed-secret' }, customProviders: { chat: [{ id: 'custom-endpoint-chat-legacy', displayName: '普通接口', baseUrl: 'http://localhost:8000/v1', modelId: 'local-chat' }], embedding: [{ id: 'custom-endpoint-embedding-legacy', displayName: '向量接口', baseUrl: 'http://localhost:8001/v1', modelId: 'local-embed' }] }, customSelection: { chat: 'custom-endpoint-chat-legacy', embedding: 'custom-endpoint-embedding-legacy' } };
  const services = hydrateModelServices(config, setup);
  const chat = services.find(s => s.legacy?.kind === 'chat')!;
  const embedding = services.find(s => s.legacy?.kind === 'embedding')!;
  expect(chat.apiKey).toBe('chat-secret'); expect(embedding.apiKey).toBe('embed-secret');
  expect(embedding.models[0].dimensions).toBe(768);
  const next = projectModelServices({ ...config, desktop: { model_services: services } }, services);
  expect(next.chat_model).toBe(config.chat_model); expect(next.embedding_model).toBe(config.embedding_model);
  expect(next.provider_touchpoint_base_urls['custom-openai']).toEqual(config.provider_touchpoint_base_urls['custom-openai']);
  expect(next.provider_touchpoint_api_keys['custom-openai']).toEqual(config.provider_touchpoint_api_keys['custom-openai']);
  expect(next.embedding_dimensions).toBe(768);
  expect(hydrateModelServices(next, setup).filter(s => s.legacy).length).toBe(2);
});
test('cloud sync explains missing API key before issuing any request', async () => {
  let calls = 0;
  await expect(syncServiceModels(platform({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }), async () => { calls++; return new Response('{}'); })).rejects.toThrow('API 密钥');
  expect(calls).toBe(0);
});
test('local OpenAI model listing supports no key, deduplicates and separates embedding', async () => {
  const result = await syncServiceModels(platform(), async (url) => {
    expect(String(url)).toBe('http://localhost:1234/v1/models');
    return Response.json({ data: [{ id: 'local-chat' }, { id: 'bge-m3', type: 'embedding' }, { id: 'local-chat' }] });
  });
  expect(result.models.map(m => [m.id, m.kind])).toEqual([['local-chat', 'chat'], ['bge-m3', 'embedding']]);
});
test('one Ollama show error does not hide installed models and reports uncertain capability', async () => {
  const result = await syncServiceModels(platform({ provider: 'ollama', baseUrl: 'http://localhost:11434/' }), async (url, init) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-chat' }, { name: 'local-embed' }, { name: 'unknown' }] });
    const name = JSON.parse(String(init?.body)).model;
    if (name === 'unknown') return new Response('', { status: 404 });
    return Response.json({ capabilities: name === 'local-chat' ? ['completion', 'vision', 'tools'] : ['embedding'], model_info: { 'bert.embedding_length': 768 } });
  });
  expect(result.models.map(m => m.kind)).toEqual(['chat', 'embedding', 'unknown']);
  expect(result.models[1].dimensions).toBe(768); expect(result.warnings.length).toBe(1);
});
test('sync reports authentication errors with actionable guidance', async () => {
  await expect(syncServiceModels(platform({ apiKey: 'bad-key' }), async () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }))).rejects.toThrow('密钥');
});
test('native provider separate touchpoints survive editing chat key', () => {
  const svc = platform({ id: 'ollama', provider: 'ollama', models: [newServiceModel('chat')], connections: { embedding: { baseUrl: 'http://localhost:8001/v1', apiKey: 'embedding-key' } } });
  const result = projectModelServices({ desktop: { model_services: [svc] } }, [{ ...svc, apiKey: 'new-chat-key' }]);
  expect(result.provider_touchpoint_api_keys.ollama).toEqual({ chat: 'new-chat-key', embedding: 'embedding-key' });
});

test('models added to a legacy embedding service use its own route for chat', () => {
  const service = platform({ legacy: { kind: 'embedding', endpointId: 'local', selected: true } });
  expect(serviceModelValue(service, newServiceModel('same', 'embedding'))).toBe('custom-openai:same');
  expect(serviceModelValue(service, newServiceModel('same', 'chat'))).toBe('service-local:same');
});
