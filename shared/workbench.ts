export interface WorkbenchCitation { sourceId: string | null; slug: string; title: string; snippet: string }
export interface WorkbenchMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  status: 'complete' | 'running' | 'error' | 'cancelled';
  model?: string;
  modelName?: string;
  error?: string;
  stage?: string;
  citations?: WorkbenchCitation[];
  knowledge?: 'used' | 'none' | 'off';
  contextMessages?: number;
  contextNote?: string;
  stopReason?: 'end' | 'length' | 'other';
}
export interface WorkbenchConversation {
  id: string;
  title: string;
  model: string;
  knowledge: boolean;
  createdAt: string;
  updatedAt: string;
  messages: WorkbenchMessage[];
  summary?: string;
  summaryUntil?: string;
}
export interface WorkbenchModel { id: string; name: string; contextWindow?: number }
export const FALLBACK_CONTEXT_TOKENS = 32_000;
export interface ContextPolicy { maxMessages: number; threshold: number; summaryModel: string }
export interface KnowledgeAssistantSettings {
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  model: string;
  knowledge: boolean;
  temperature: number | null;
  context: ContextPolicy;
}
export function defaultAssistant(): KnowledgeAssistantSettings {
  return {
    name: '知识库助手',
    emoji: '知',
    description: '基于当前知识库回答，并记住这段对话。',
    systemPrompt: '',
    model: '',
    knowledge: true,
    temperature: null,
    context: { maxMessages: 24, threshold: 0.8, summaryModel: '' },
  };
}
export function normalizeAssistant(input: unknown): KnowledgeAssistantSettings {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const context = raw.context && typeof raw.context === 'object' ? raw.context as Record<string, unknown> : {};
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 40) throw new Error('助手名称需为 1–40 个字符');
  const emoji = String(raw.emoji ?? '').trim();
  if (!emoji || [...emoji].length > 8) throw new Error('请填写 1–8 个字符的头像');
  const description = String(raw.description ?? '').trim();
  if (description.length > 200) throw new Error('描述不超过 200 个字符');
  const systemPrompt = String(raw.systemPrompt ?? '');
  if (systemPrompt.length > 8000) throw new Error('系统提示词不超过 8000 个字符');
  const model = String(raw.model ?? '').trim();
  if (model.length > 200) throw new Error('请选择对话模型');
  const maxMessages = Number(context.maxMessages);
  if (!Number.isInteger(maxMessages) || maxMessages < 2 || maxMessages > 500) throw new Error('最大上下文消息数需为 2–500 的整数');
  let threshold = Number(context.threshold);
  if (threshold > 1) threshold /= 100;
  if (!(threshold >= 0.5 && threshold <= 0.95)) throw new Error('压缩阈值需在 50% 到 95% 之间');
  const summaryModel = String(context.summaryModel ?? '').trim();
  if (summaryModel.length > 200) throw new Error('请选择摘要模型');
  let temperature: number | null = null;
  if (raw.temperature !== null && raw.temperature !== undefined && raw.temperature !== '') {
    const value = Number(raw.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) throw new Error('温度需在 0 到 2 之间');
    temperature = Math.round(value * 10) / 10;
  }
  return {
    name, emoji, description, systemPrompt, model, knowledge: raw.knowledge !== false, temperature,
    context: { maxMessages, threshold: Math.round(threshold * 100) / 100, summaryModel },
  };
}
