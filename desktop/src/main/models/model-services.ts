import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { desktopConfigPath, backupFile, writeJsonConfig, getSetupInfo } from '../config-manager.js';
import { getRecipe } from '../../../../src/core/ai/recipes/index.js';
import { SERVICE_PRESETS, newServiceModel, type ModelService, type ModelServicesState, type ServiceModel } from '../../../../shared/model-services.js';

function rawConfig(): Record<string, any> {
  const path = desktopConfigPath();
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
}
function revision(config: unknown): string { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
export function mergeModelServices(existing: ServiceModel[], incoming: ServiceModel[]): ServiceModel[] {
  const models = new Map(existing.map(model => [model.id, model]));
  for (const model of incoming) if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}
export function readModelServices(): ModelServicesState {
  const config = rawConfig();
  const setup = getSetupInfo().current;
  const stored: ModelService[] = config.desktop?.model_services ?? [];
  const services = SERVICE_PRESETS.map(([provider, name, baseUrl]): ModelService => {
    const saved = stored.find(service => service.provider === provider);
    if (saved) return saved;
    const recipe = getRecipe(provider);
    const models = [...(recipe?.touchpoints.chat?.models ?? [])].map(id => newServiceModel(id));
    for (const id of recipe?.touchpoints.embedding?.models ?? []) if (!models.some(m => m.id === id)) models.push(newServiceModel(id, 'embedding'));
    for (const [kind, full] of [['chat', setup.chatModel], ['embedding', setup.embeddingModel], ['chat', setup.ocrModel]] as const) {
      if (full?.startsWith(`${provider}:`)) {
        const id = full.slice(provider.length + 1);
        if (!models.some(m => m.id === id)) models.push(newServiceModel(id, kind));
      }
    }
    const apiKey = config.provider_touchpoint_api_keys?.[provider]?.chat ?? config.provider_touchpoint_api_keys?.[provider]?.embedding ?? setup.keyValues[provider] ?? '';
    return { id: provider, provider, name, baseUrl: config.provider_base_urls?.[provider] ?? baseUrl, apiKey, enabled: Boolean(apiKey || [setup.chatModel, setup.embeddingModel, setup.ocrModel].some(m => m?.startsWith(`${provider}:`))), models };
  });
  for (const service of stored) if (!services.some(item => item.id === service.id)) services.push(service);
  const legacy = setup.customProviders;
  for (const kind of ['chat', 'embedding'] as const) for (const endpoint of legacy?.[kind] ?? []) {
    if (stored.length || services.some(s => s.id === endpoint.id)) continue;
    services.push({ id: endpoint.id, provider: `service-${endpoint.id}`, name: endpoint.displayName, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey ?? '', enabled: true, models: [newServiceModel(endpoint.modelId, kind)] });
  }
  return { services, revision: revision(config) };
}
function validateService(service: ModelService): void {
  if (!service || typeof service.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(service.id) || !getRecipe(service.provider)) throw new Error('无效的模型平台');
  if (!service.name?.trim() || service.name.length > 100 || typeof service.apiKey !== 'string' || service.apiKey.length > 8192 || typeof service.enabled !== 'boolean') throw new Error('请检查平台名称与密钥');
  const url = new URL(service.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须为不含账号、查询参数的 HTTP(S) 地址');
  if (!Array.isArray(service.models) || service.models.length > 5000 || new Set(service.models.map(m => m.id)).size !== service.models.length) throw new Error('模型列表无效或有重复 ID');
  for (const model of service.models) {
    if (typeof model.name !== 'string' || typeof model.group !== 'string' || model.name.length > 250 || model.group.length > 100) throw new Error('模型名称或分组无效');
    if (!model.id?.trim() || model.id.length > 250 || /[\r\n]/.test(model.id) || !['chat', 'embedding'].includes(model.kind)) throw new Error('请检查模型 ID 和类型');
    if (!Array.isArray(model.capabilities) || model.capabilities.some(c => !['vision', 'reasoning', 'tools', 'web'].includes(c))) throw new Error('模型能力标签无效');
    for (const value of [model.inputPrice, model.outputPrice, model.contextWindow]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('价格及上下文长度必须为非负数');
  }
}
export function projectModelServices(config: Record<string, any>, services: ModelService[]): Record<string, any> {
  if (!Array.isArray(services) || services.length > 100 || new Set(services.map(s => s.id)).size !== services.length || new Set(services.map(s => s.provider)).size !== services.length) throw new Error('模型平台列表无效');
  const selected = [config.chat_model, config.embedding_model, config.ocr_model, config.expansion_model, config.reranker_model, config.embedding_image_ocr_model, ...(config.chat_fallback_chain ?? []), ...Object.entries(config).filter(([key]) => key.startsWith('models.')).map(([, value]) => value)].filter((v): v is string => typeof v === 'string');
  const next = structuredClone(config);
  next.provider_base_urls ??= {};
  next.provider_touchpoint_api_keys ??= {};
  next.provider_touchpoint_base_urls ??= {};
  for (const service of services) {
    validateService(service);
    const active = selected.filter(value => value.startsWith(`${service.provider}:`));
    if (active.length && (!service.enabled || active.some(full => !service.models.some(m => `${service.provider}:${m.id}` === full)))) throw new Error(`${service.name} 的模型仍在使用，请先修改知识库模型配置`);
    const old: ModelService | undefined = config.desktop?.model_services?.find((s: ModelService) => s.id === service.id);
    if (old?.apiKey && !service.apiKey && service.enabled) throw new Error('请填写密钥，或先停用该平台');
    if (active.length && old && old.baseUrl !== service.baseUrl) throw new Error('该平台仍在使用。请添加新平台后切换用途，避免隐式更换向量空间');
    if (!service.enabled) continue;
    if (old && old.baseUrl === service.baseUrl && old.apiKey === service.apiKey && old.enabled === service.enabled && (!service.provider.startsWith('service-') || config.provider_base_urls?.[service.provider])) continue;
    next.provider_base_urls[service.provider] = service.baseUrl.replace(/\/+$/, '');
    next.provider_touchpoint_base_urls[service.provider] = { ...next.provider_touchpoint_base_urls[service.provider], chat: service.baseUrl, embedding: service.baseUrl };
    next.provider_touchpoint_api_keys[service.provider] = { ...next.provider_touchpoint_api_keys[service.provider], chat: service.apiKey, embedding: service.apiKey };
  }
  for (const old of config.desktop?.model_services ?? []) if (!services.some(s => s.id === old.id) && selected.some(m => m.startsWith(`${old.provider}:`))) throw new Error('不能移除正在使用的模型平台');
  next.desktop = { ...next.desktop, model_services: services };
  return next;
}
export function saveModelServices(input: ModelServicesState): ModelServicesState {
  const config = rawConfig();
  if (revision(config) !== input.revision) throw new Error('配置已变化，请重新加载后保存');
  const baseline = readModelServices();
  const next = projectModelServices({ ...config, desktop: { ...config.desktop, model_services: baseline.services } }, input.services);
  backupFile(desktopConfigPath(), 'config');
  writeJsonConfig(desktopConfigPath(), next);
  return readModelServices();
}
export async function syncServiceModels(service: ModelService, fetchImpl: typeof fetch = fetch): Promise<ServiceModel[]> {
  validateService(service);
  const base = service.baseUrl.replace(/\/+$/, '');
  const ollama = service.provider === 'ollama';
  const headers: Record<string, string> = {};
  if (service.apiKey) {
    if (service.provider === 'anthropic') { headers['x-api-key'] = service.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else if (service.provider === 'google') headers['x-goog-api-key'] = service.apiKey;
    else headers.Authorization = `Bearer ${service.apiKey}`;
  }
  const root = ollama ? base.replace(/\/v1$/, '') : base;
  const response = await fetchImpl(`${root}/${ollama ? 'api/tags' : 'models'}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`同步失败：HTTP ${response.status}`);
  const body = await response.json() as any;
  const records = ollama || service.provider === 'google' ? body.models : body.data;
  if (!Array.isArray(records)) throw new Error('平台未返回有效模型列表');
  const models: ServiceModel[] = [];
  for (const record of records) {
    const id = String(record.id ?? record.name ?? record.model ?? '').replace(/^models\//, '');
    if (!id) continue;
    let capabilities: string[] = [];
    if (ollama) {
      const detail = await fetchImpl(`${root}/api/show`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id }), redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!detail.ok) throw new Error(`读取 ${id} 能力失败：HTTP ${detail.status}`);
      capabilities = ((await detail.json()) as any).capabilities ?? [];
    }
    const model = newServiceModel(id, capabilities.includes('embedding') || /embed|bge-|e5-/i.test(id) ? 'embedding' : 'chat');
    model.name = record.displayName ?? record.display_name ?? id;
    if (capabilities.includes('vision')) model.capabilities.push('vision');
    if (capabilities.includes('thinking')) model.capabilities.push('reasoning');
    if (capabilities.includes('tools')) model.capabilities.push('tools');
    models.push(model);
  }
  return models;
}
