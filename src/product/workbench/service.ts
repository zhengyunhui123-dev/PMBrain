import { randomUUID } from 'node:crypto';
import type { WorkbenchCitation, WorkbenchConversation, WorkbenchMessage, WorkbenchModel } from '../../../shared/workbench';
import { planContext } from './context';
import { WorkbenchStore } from './store';

export { conversationContext } from './context';

const SUMMARY_BATCH = 8_000;
const SUMMARY_LIMIT = 6_000;

export interface WorkbenchAnswerInput {
  messages: WorkbenchMessage[];
  summary?: string;
  model: string;
  knowledge: boolean;
  systemPrompt?: string;
  temperature?: number;
  signal: AbortSignal;
  progress: (stage: string) => void;
  onDelta?: (delta: string) => void;
  onReplace?: (text: string, model: string) => void;
}
export type WorkbenchAnswer = (input: WorkbenchAnswerInput) => Promise<{ text: string; model: string; citations: WorkbenchCitation[]; knowledge?: 'used' | 'none' | 'off'; stopReason?: 'end' | 'length' | 'other' }>;
export type WorkbenchSummarizer = (input: { model: string; prior: string; transcript: string; signal: AbortSignal }) => Promise<string>;

async function compressOlder(model: string, prior: string, pending: WorkbenchMessage[], signal: AbortSignal, summarize?: WorkbenchSummarizer): Promise<string> {
  if (!pending.length) return prior;
  if (!summarize) throw new Error('对话摘要服务不可用，请稍后重试');
  const batches: string[] = [];
  let batch = '';
  for (const message of pending) {
    for (let offset = 0; offset < message.text.length; offset += SUMMARY_BATCH) {
      const line = `${message.role === 'user' ? '用户' : '助手'}${offset ? '（续）' : ''}：${message.text.slice(offset, offset + SUMMARY_BATCH)}`;
      if (batch && batch.length + line.length > SUMMARY_BATCH) { batches.push(batch); batch = ''; }
      batch += `${line}\n`;
    }
  }
  if (batch) batches.push(batch);
  let summary = prior;
  for (const transcript of batches) {
    signal.throwIfAborted();
    const next = (await summarize({ model, prior: summary, transcript, signal })).trim();
    if (!next || next.length > SUMMARY_LIMIT) throw new Error('对话摘要为空或超过长度限制，请重试');
    summary = next;
  }
  return summary;
}

export class WorkbenchService {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  constructor(private store: WorkbenchStore, private models: () => WorkbenchModel[], private answer: WorkbenchAnswer, private summarize?: WorkbenchSummarizer) {
    for (const conversation of store.list()) {
      let changed = false;
      for (const message of conversation.messages) if (message.status === 'running') { message.status = 'error'; message.error = '上次生成因服务退出而中断，请重试。'; changed = true; }
      if (changed) store.save(conversation);
    }
  }
  list() { return this.store.list().map(({ messages, ...row }) => ({ ...row, messageCount: messages.length, running: this.active.has(row.id) })); }
  get(id: string) { return this.store.get(id); }
  assistant() { return this.store.assistant(); }
  saveAssistant(input: unknown) { return this.store.saveAssistant(input); }
  private model(id?: string) {
    const models = this.models(); const model = id || models[0]?.id;
    if (!model || !models.some(item => item.id === model)) throw new Error('请先在模型服务中启用并保存普通模型');
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
  remove(id: string, emptyOnly = false) {
    if (this.active.has(id)) throw new Error('请先停止当前生成');
    if (emptyOnly && this.get(id).messages.length) throw new Error('会话已有消息，不能自动清理');
    this.store.remove(id);
  }
  send(id: string, input: { text?: string; model?: string; knowledge?: boolean; retry?: boolean; editMessageId?: string }) {
    if (this.active.has(id)) throw new Error('当前会话正在生成，请等待或停止');
    const conversation = this.get(id); const model = this.model(input.model ?? conversation.model);
    const now = new Date().toISOString();
    if (input.editMessageId) {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000) throw new Error('请输入 1–32000 个字符');
      const index = conversation.messages.findIndex(message => message.id === input.editMessageId);
      const target = conversation.messages[index];
      if (!target || target.role !== 'user') throw new Error('只能修改你发送的问题');
      const previous = target.text;
      target.text = input.text.trim();
      conversation.messages.splice(index + 1);
      if (index === 0 && (conversation.title === '新对话' || conversation.title === previous.slice(0, 40))) conversation.title = target.text.slice(0, 40);
      if (conversation.summaryUntil) {
        const anchor = conversation.messages.findIndex(message => message.id === conversation.summaryUntil);
        if (anchor === -1 || anchor >= index) { delete conversation.summary; delete conversation.summaryUntil; }
      }
    } else if (input.retry) {
      if (conversation.messages.at(-1)?.role !== 'assistant') throw new Error('没有可重新生成的回答');
      conversation.messages.pop();
    } else {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32000) throw new Error('请输入 1–32000 个字符');
      conversation.messages.push({ id: randomUUID(), role: 'user', text: input.text.trim(), createdAt: now, status: 'complete' });
      if (conversation.messages.length === 1) conversation.title = input.text.trim().slice(0, 40);
    }
    conversation.model = model; conversation.knowledge = input.knowledge ?? conversation.knowledge; conversation.updatedAt = now;
    const assistant = this.store.assistant();
    const contextWindow = this.models().find(item => item.id === model)?.contextWindow;
    const { recent, older } = planContext(conversation.messages, assistant.context, { contextWindow, summary: conversation.summary });
    const olderTurns = older.filter(message => message.role === 'user').length;
    const modelName = this.models().find(item => item.id === model)?.name || model;
    const reply: WorkbenchMessage = {
      id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model, modelName,
      stage: olderTurns ? '正在压缩更早的对话' : '正在准备回答', contextMessages: recent.length,
      ...(olderTurns ? { contextNote: `正在处理更早的 ${olderTurns} 轮对话` } : {}),
    };
    conversation.messages.push(reply); this.store.save(conversation);
    const abort = new AbortController();
    let lastSave = 0;
    const saveSoon = (force = false) => {
      if (abort.signal.aborted && !force) return;
      const nowMs = Date.now();
      if (!force && lastSave !== 0 && nowMs - lastSave < 80) return;
      lastSave = nowMs; this.store.save(conversation);
    };
    const promise = Promise.resolve().then(async () => {
      try {
        let summary = conversation.summary;
        if (older.length) {
          let prior = conversation.summary ?? '';
          let pending = older;
          if (conversation.summaryUntil) {
            const anchor = older.findIndex(message => message.id === conversation.summaryUntil);
            if (anchor === -1) prior = '';
            else pending = older.slice(anchor + 1);
          }
          if (pending.length || !prior) {
            reply.stage = '正在压缩更早的对话';
            saveSoon(true);
            const summaryModel = assistant.context.summaryModel;
            const summarizerModel = summaryModel && this.models().some(item => item.id === summaryModel) ? summaryModel : model;
            const compressed = await compressOlder(summarizerModel, prior, pending, abort.signal, this.summarize);
            if (abort.signal.aborted) return;
            summary = compressed;
            conversation.summary = summary;
            conversation.summaryUntil = older[older.length - 1]!.id;
            saveSoon(true);
          } else summary = prior;
          reply.contextNote = `更早的 ${olderTurns} 轮已压缩为摘要，仍会参与这次回答`;
        }
        const result = await this.answer({
          messages: recent, ...(summary ? { summary } : {}), model, knowledge: conversation.knowledge,
          ...(assistant.systemPrompt.trim() ? { systemPrompt: assistant.systemPrompt } : {}),
          ...(assistant.temperature !== null ? { temperature: assistant.temperature } : {}),
          signal: abort.signal,
          progress: stage => { if (abort.signal.aborted) return; reply.stage = stage; saveSoon(true); },
          onDelta: delta => {
            if (abort.signal.aborted || !delta) return;
            const first = reply.text.length === 0;
            reply.text += delta;
            saveSoon(first);
          },
          onReplace: (text, nextModel) => {
            if (abort.signal.aborted) return;
            reply.text = text; reply.model = nextModel;
            reply.modelName = this.models().find(item => item.id === nextModel)?.name || nextModel;
            saveSoon(true);
          },
        });
        if (!abort.signal.aborted) {
          reply.text = result.text;
          reply.model = result.model || model;
          reply.modelName = this.models().find(item => item.id === reply.model)?.name || reply.modelName;
          reply.citations = result.citations;
          reply.knowledge = result.knowledge ?? (conversation.knowledge ? (result.citations?.length ? 'used' : 'none') : 'off');
          if (result.stopReason) reply.stopReason = result.stopReason;
          reply.status = 'complete';
        }
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
