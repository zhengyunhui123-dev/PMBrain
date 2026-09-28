import { randomUUID } from 'node:crypto';
import type { WorkbenchCitation, WorkbenchConversation, WorkbenchMessage, WorkbenchModel } from '../../../shared/workbench';
import { WorkbenchStore } from './store';

export interface WorkbenchAnswerInput {
  messages: WorkbenchMessage[];
  model: string;
  knowledge: boolean;
  signal: AbortSignal;
  progress: (stage: string) => void;
}
export type WorkbenchAnswer = (input: WorkbenchAnswerInput) => Promise<{ text: string; model: string; citations: WorkbenchCitation[] }>;
export function conversationContext(messages: WorkbenchMessage[]): WorkbenchMessage[] {
  const result: WorkbenchMessage[] = []; let size = 0;
  for (const message of [...messages].reverse()) {
    if (message.status !== 'complete') continue;
    if (size + message.text.length > 80000 || result.length >= 40) break;
    result.unshift(message); size += message.text.length;
  }
  while (result[0]?.role === 'assistant') result.shift();
  return result;
}
export class WorkbenchService {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  constructor(private store: WorkbenchStore, private models: () => WorkbenchModel[], private answer: WorkbenchAnswer) {
    for (const conversation of store.list()) {
      let changed = false;
      for (const message of conversation.messages) if (message.status === 'running') { message.status = 'error'; message.error = '上次生成因服务退出而中断，请重试。'; changed = true; }
      if (changed) store.save(conversation);
    }
  }
  list() { return this.store.list().map(({ messages, ...row }) => ({ ...row, messageCount: messages.length, running: this.active.has(row.id) })); }
  get(id: string) { return this.store.get(id); }
  private model(id?: string) {
    const models = this.models(); const model = id || models[0]?.id;
    if (!model || !models.some(m => m.id === model)) throw new Error('请先在模型服务中启用并保存普通模型');
    return model;
  }
  create(input: { model?: string; knowledge?: boolean }): WorkbenchConversation {
    const now = new Date().toISOString();
    const conversation = { id: randomUUID(), title: '新对话', model: input.model || this.models()[0]?.id || '', knowledge: input.knowledge !== false, createdAt: now, updatedAt: now, messages: [] };
    this.store.save(conversation); return conversation;
  }
  rename(id: string, title: string) {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('会话标题需为 1–120 个字符');
    const conversation = this.get(id); conversation.title = title.trim(); conversation.updatedAt = new Date().toISOString(); this.store.save(conversation); return conversation;
  }
  remove(id: string) { if (this.active.has(id)) throw new Error('请先停止当前生成'); this.store.remove(id); }
  send(id: string, input: { text?: string; model?: string; knowledge?: boolean; retry?: boolean }) {
    if (this.active.has(id)) throw new Error('当前会话正在生成，请等待或停止');
    const conversation = this.get(id); const model = this.model(input.model ?? conversation.model);
    const now = new Date().toISOString();
    if (input.retry) {
      if (conversation.messages.at(-1)?.role !== 'assistant') throw new Error('没有可重新生成的回答');
      conversation.messages.pop();
    } else {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000) throw new Error('请输入 1–32000 个字符');
      if (conversation.messages.length >= 400) throw new Error('本会话已达到 200 轮，请新建对话');
      conversation.messages.push({ id: randomUUID(), role: 'user', text: input.text.trim(), createdAt: now, status: 'complete' });
      if (conversation.messages.length === 1) conversation.title = input.text.trim().slice(0, 40);
    }
    conversation.model = model; conversation.knowledge = input.knowledge ?? conversation.knowledge; conversation.updatedAt = now;
    const context = conversationContext(conversation.messages);
    const reply: WorkbenchMessage = { id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model, stage: '正在准备回答', contextMessages: context.length };
    conversation.messages.push(reply); this.store.save(conversation);
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.answer({ messages: context, model, knowledge: conversation.knowledge, signal: abort.signal, progress: stage => { if (abort.signal.aborted) return; reply.stage = stage; this.store.save(conversation); } });
        if (!abort.signal.aborted) { reply.text = result.text; reply.model = result.model; reply.citations = result.citations; reply.status = 'complete'; }
      } catch (error) { if (!abort.signal.aborted) { reply.status = 'error'; reply.error = error instanceof Error ? error.message : String(error); } }
      finally { if (abort.signal.aborted) reply.status = 'cancelled'; delete reply.stage; conversation.updatedAt = new Date().toISOString(); this.store.save(conversation); this.active.delete(id); }
    });
    this.active.set(id, { abort, promise }); return conversation;
  }
  cancel(id: string) {
    this.active.get(id)?.abort.abort();
    const conversation = this.get(id); const reply = conversation.messages.at(-1);
    if (reply?.status === 'running') { reply.status = 'cancelled'; delete reply.stage; this.store.save(conversation); }
    return conversation;
  }
  async settled(id: string) { await this.active.get(id)?.promise; }
}
