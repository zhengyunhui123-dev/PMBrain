export type ModelCapability = 'vision' | 'reasoning' | 'tools' | 'web';
export interface ServiceModel {
  id: string;
  name: string;
  group: string;
  kind: 'chat' | 'embedding' | 'unknown';
  capabilities: ModelCapability[];
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  dimensions?: number;
  typeOverride?: boolean;
}
export interface ModelService {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: ServiceModel[];
  connections?: Partial<Record<'chat' | 'embedding', { baseUrl: string; apiKey: string }>>;
  legacy?: { kind: 'chat' | 'embedding'; endpointId: string; selected: boolean };
}
export interface ModelSyncResult { models: ServiceModel[]; warnings: string[] }
export function serviceConnection(service: ModelService, kind: 'chat' | 'embedding' = 'chat') {
  return service.connections?.[kind] ?? { baseUrl: service.baseUrl, apiKey: service.apiKey };
}
export interface ModelServicesState { services: ModelService[]; revision: string }
export function mergeServiceModels(existing: ServiceModel[], incoming: ServiceModel[]): ServiceModel[] {
  const models = new Map(existing.map(model => [model.id, model]));
  for (const model of incoming) {
    const old = models.get(model.id);
    models.set(model.id, old ? { ...model, ...old, kind: old.typeOverride || model.kind === 'unknown' ? old.kind : model.kind, capabilities: old.capabilities.length ? old.capabilities : model.capabilities } : model);
  }
  return [...models.values()];
}
export const SERVICE_PRESETS = [
  ['ollama', 'Ollama', 'http://localhost:11434/v1'],
  ['deepseek', '深度求索', 'https://api.deepseek.com/v1'],
  ['service-siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1'],
  ['zhipu', '智谱开放平台', 'https://open.bigmodel.cn/api/paas/v4'],
  ['mimo', '小米 MiMo', 'https://api.xiaomimimo.com/v1'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1'],
  ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1'],
  ['google', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
  ['dashscope', '阿里云百炼', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['service-moonshot', '月之暗面', 'https://api.moonshot.cn/v1'],
  ['service-lmstudio', 'LM Studio', 'http://localhost:1234/v1'],
  ['minimax', 'MiniMax', 'https://api.minimaxi.com/v1'],
  ['groq', 'Groq', 'https://api.groq.com/openai/v1'],
  ['together', 'Together AI', 'https://api.together.xyz/v1'],
  ['voyage', 'Voyage AI', 'https://api.voyageai.com/v1'],
] as const;
export function newServiceModel(id: string, kind: ServiceModel['kind'] = 'chat'): ServiceModel {
  return { id, name: id, kind, group: id.split('/')[0].split(':')[0], capabilities: [] };
}
export function serviceModelValue(service: ModelService, model: ServiceModel): string {
  return `${service.legacy?.selected && service.legacy.kind === model.kind ? 'custom-openai' : service.provider}:${model.id}`;
}
export function availableServiceModels(services: ModelService[], kind: ServiceModel['kind']) {
  return services.filter(service => service.enabled).flatMap(service => service.models.filter(model => model.kind === kind).map(model => ({ value: serviceModelValue(service, model), label: `${model.name} · ${service.name}`, model, service })));
}
export type ServiceModelFilter = 'all' | ServiceModel['kind'];
export function serviceEndpointError(service: { name: string; baseUrl: string }): string | null {
  try {
    const url = new URL(service.baseUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return `${service.name}：API 地址必须为不含账号、查询参数的 HTTP(S) 地址`;
  } catch { return `${service.name}：请填写完整的 API 地址，例如 http://localhost:1234/v1`; }
  return null;
}
export function listedServiceModels(models: ServiceModel[], query: string, filter: ServiceModelFilter = 'all'): ServiceModel[] {
  const text = query.trim().toLowerCase();
  return models.filter(model => (filter === 'all' || model.kind === filter) && (!text || `${model.name} ${model.id}`.toLowerCase().includes(text)));
}
export function serviceModelsNotOnRemote(local: ServiceModel[], remote: ServiceModel[]): ServiceModel[] {
  const ids = new Set(remote.map(model => model.id));
  return local.filter(model => !ids.has(model.id));
}
