export type ModelCapability = 'vision' | 'reasoning' | 'tools' | 'web';
export interface ServiceModel {
  id: string;
  name: string;
  group: string;
  kind: 'chat' | 'embedding';
  capabilities: ModelCapability[];
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
}
export interface ModelService {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: ServiceModel[];
}
export interface ModelServicesState { services: ModelService[]; revision: string }
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
  return `${service.provider}:${model.id}`;
}
export function availableServiceModels(services: ModelService[], kind: ServiceModel['kind']) {
  return services.filter(service => service.enabled).flatMap(service => service.models.filter(model => model.kind === kind).map(model => ({ value: serviceModelValue(service, model), label: `${model.name} · ${service.name}`, model, service })));
}
