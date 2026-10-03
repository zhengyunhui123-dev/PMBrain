import { randomUUID } from 'node:crypto';
import type { WorkbenchCitation, WorkbenchConversation, WorkbenchMessage, WorkbenchModel, WorkbenchToolCall } from '../../../shared/workbench';
import { advanceStoredReads, attachmentRead, enrichAttachments, incomingAttachments, resolveListedAttachments, summarySource, modelReadsPdfNatively } from './attachments';
import { estimateTokens, knowledgeReserve, planContext, summaryInputBudget } from './context';
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
  contextWindow?: number;
  contextThreshold?: number;
  signal: AbortSignal;
  attachmentSupplement?: string;
  progress: (stage: string) => void;
  onDelta?: (delta: string) => void;
  onReplace?: (text: string, model: string) => void;
  onTool?: (call: WorkbenchToolCall) => void;
}
export type WorkbenchAnswer = (input: WorkbenchAnswerInput) => Promise<{ text: string; model: string; citations: WorkbenchCitation[]; knowledge?: 'used' | 'none' | 'off'; stopReason?: 'end' | 'length' | 'other' }>;
export type WorkbenchSummarizer = (input: { model: string; prior: string; transcript: string; signal: AbortSignal; contextWindow?: number }) => Promise<string>;

async function compressOlder(model: string, prior: string, pending: WorkbenchMessage[], signal: AbortSignal, summarize?: WorkbenchSummarizer, contextWindow?: number): Promise<string> {
  if (!pending.length) return prior;
  if (!summarize) throw new Error('对话摘要服务不可用，请稍后重试');
  const budget = summaryInputBudget(contextWindow);
  let batch = '';
  let summary = prior;
  const flush = async () => {
    if (!batch) return;
    signal.throwIfAborted();
    if (estimateTokens(summary) + estimateTokens(batch) > budget) throw new Error('对话摘要超出摘要模型上下文预算，请选择上下文更大的摘要模型。');
    const next = (await summarize({ model, prior: summary, transcript: batch, signal, contextWindow })).trim();
    if (!next || next.length > SUMMARY_LIMIT) throw new Error('对话摘要为空或超过长度限制，请重试');
    summary = next;
    batch = '';
  };
  for (const message of pending) {
    const body = summarySource(message);
    let offset = 0;
    while (offset < body.length) {
      const room = Math.floor(Math.min(SUMMARY_BATCH - batch.length, budget - estimateTokens(summary) - estimateTokens(batch) - 32));
      if (room <= 0) {
        if (!batch) throw new Error('对话摘要超出摘要模型上下文预算，请选择上下文更大的摘要模型。');
        await flush(); continue;
      }
      let part = body.slice(offset, offset + room);
      while (estimateTokens(part) > room) part = part.slice(0, Math.floor(part.length * .8));
      if (!part) throw new Error('对话摘要超出摘要模型上下文预算，请选择上下文更大的摘要模型。');
      batch += `${message.role === 'user' ? '用户' : '助手'}${offset ? '（续）' : ''}：${part}\n`;
      offset += part.length;
      if (offset < body.length) await flush();
    }
  }
  await flush();
  return summary;
}

export class WorkbenchService {
  private active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private acceptance = new Map<string, Promise<WorkbenchConversation>>();
  constructor(private store: WorkbenchStore, private models: () => WorkbenchModel[], private answer: WorkbenchAnswer, private summarize?: WorkbenchSummarizer, private attachmentIo?: {
    ocr?: (bytes: Buffer, mime: string, signal: AbortSignal) => Promise<string>;
    office?: (bytes: Buffer, name: string, signal: AbortSignal) => Promise<string>;
  }) {
    for (const conversation of store.list()) {
      let changed = false;
      for (const message of conversation.messages) if (message.status === 'running') {
        message.status = 'error'; message.error = '上次生成因服务退出而中断，请重试。';
        for (const call of message.toolCalls ?? []) if (call.status === 'running') { call.status = 'error'; call.error = message.error; call.completedAt = new Date().toISOString(); }
        changed = true;
      }
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
  send(id: string, input: { text?: string; model?: string; knowledge?: boolean; retry?: boolean; editMessageId?: string; attachments?: unknown; attachmentsHydrated?: boolean }) {
    if (this.active.has(id)) throw new Error('当前会话正在生成，请等待或停止');
    const conversation = this.get(id); const model = this.model(input.model ?? conversation.model);
    const now = new Date().toISOString();
    const attachmentFlags = { vision: this.models().find(item => item.id === model)?.vision === true, pdfNative: modelReadsPdfNatively() };
    const snapshot = JSON.stringify(conversation);
    const previousAttachmentIds = new Set(conversation.messages.flatMap(message => (message.attachments ?? []).map(item => item.id)));
    if (input.editMessageId) {
      const index = conversation.messages.findIndex(message => message.id === input.editMessageId);
      const target = conversation.messages[index];
      if (!target || target.role !== 'user') throw new Error('只能修改你发送的问题');
      const nextAttachments = input.attachments === undefined ? undefined : resolveListedAttachments(input.attachments, target.attachments ?? [], attachmentFlags);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length > 32000) throw new Error('请输入 1–32000 个字符');
      const kept = nextAttachments
        ? (input.attachmentsHydrated === true ? nextAttachments.length : (target.attachments?.length ?? 0) + nextAttachments.filter(item => !(target.attachments ?? []).some(current => current.id === item.id)).length)
        : (target.attachments?.length ?? 0);
      if (!text && !kept) throw new Error('请输入 1–32000 个字符');
      const previous = target.text;
      target.text = text;
      if (nextAttachments) this.applyEditedAttachments(conversation.id, target, nextAttachments, input.attachmentsHydrated === true);
      conversation.messages.splice(index + 1);
      if (index === 0 && (conversation.title === '新对话' || conversation.title === previous.slice(0, 40))) conversation.title = (text || nextAttachments?.[0]?.name || previous).slice(0, 40);
      if (conversation.summaryUntil) {
        const anchor = conversation.messages.findIndex(message => message.id === conversation.summaryUntil);
        if (anchor === -1 || anchor >= index) { delete conversation.summary; delete conversation.summaryUntil; }
      }
    } else if (input.retry) {
      if (conversation.messages.at(-1)?.role !== 'assistant') throw new Error('没有可重新生成的回答');
      conversation.messages.pop();
    } else {
      const nextAttachments = incomingAttachments(input.attachments, attachmentFlags);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length > 32000 || (!text && !nextAttachments.length)) throw new Error('请输入 1–32000 个字符');
      conversation.messages.push({ id: randomUUID(), role: 'user', text, createdAt: now, status: 'complete', ...(nextAttachments.length ? { attachments: nextAttachments } : {}) });
      if (conversation.messages.length === 1) conversation.title = (text || nextAttachments[0]?.name || '\u9644\u4ef6').slice(0, 40);
    }
    conversation.model = model; conversation.knowledge = input.knowledge ?? conversation.knowledge; conversation.updatedAt = now;
    const assistant = this.store.assistant();
    const contextWindow = this.models().find(item => item.id === model)?.contextWindow;
    const modelName = this.models().find(item => item.id === model)?.name || model;
    const hasAttachments = conversation.messages.some(message => message.attachments?.length);
    const reply: WorkbenchMessage = {
      id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'running', model, modelName,
      stage: hasAttachments ? '正在读取附件' : '正在准备回答',
    };
    conversation.messages.push(reply); this.store.save(conversation);
    const abort = new AbortController();
    let opened = false;
    let acceptReady!: (value: WorkbenchConversation) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<WorkbenchConversation>((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    ready.catch(() => undefined);
    this.acceptance.set(id, ready);
    let lastSave = 0;
    const saveSoon = (force = false) => {
      if (abort.signal.aborted && !force) return;
      const nowMs = Date.now();
      if (!force && lastSave !== 0 && nowMs - lastSave < 80) return;
      lastSave = nowMs; this.store.save(conversation);
    };
    const promise = (async () => {
      try {
        const userTurn = [...conversation.messages].reverse().find(message => message.role === 'user');
        try {
          await this.prepareTurnAttachments(conversation, attachmentFlags, abort.signal);
          if (abort.signal.aborted) throw Object.assign(new Error('已停止生成'), { name: 'AbortError' });
          const moved = input.retry ? [] : advanceStoredReads(conversation.messages, userTurn?.text ?? '');
          if (moved.length && userTurn) userTurn.attachmentSupplement = moved.map(item => item.excerpt).join('\n\n');
          this.dropRemovedAttachments(snapshot, conversation);
          saveSoon(true);
          opened = true;
          acceptReady(conversation);
        } catch (error) {
          if (!opened) {
            this.rollback(conversation, snapshot, previousAttachmentIds);
            const failure = error instanceof Error && error.name === 'AbortError' ? new Error('已停止生成') : error;
            rejectReady(failure instanceof Error ? failure : new Error(String(failure)));
            return;
          }
          throw error;
        }
        const contextOptions = { contextWindow, systemPrompt: assistant.systemPrompt, additionalTokens: conversation.knowledge ? knowledgeReserve(contextWindow, assistant.context.threshold) : 0 };
        let { recent, older } = planContext(conversation.messages, assistant.context, { ...contextOptions, summary: conversation.summary });
        const olderTurns = older.filter(message => message.role === 'user').length;
        reply.contextMessages = recent.length;
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
            const compressed = await compressOlder(summarizerModel, prior, pending, abort.signal, this.summarize, this.models().find(item => item.id === summarizerModel)?.contextWindow);
            if (abort.signal.aborted) return;
            summary = compressed;
            conversation.summary = summary;
            conversation.summaryUntil = older[older.length - 1]!.id;
            saveSoon(true);
          } else summary = prior;
          reply.contextNote = `更早的 ${olderTurns} 轮已压缩为摘要，仍会参与这次回答`;
        }
        for (let attempt = 0; attempt < conversation.messages.length; attempt++) {
          const planned = planContext(conversation.messages, assistant.context, { ...contextOptions, summary });
          const extra = planned.older.filter(message => !older.some(item => item.id === message.id));
          recent = planned.recent;
          if (!extra.length) break;
          const summaryModel = assistant.context.summaryModel;
          const summarizerModel = summaryModel && this.models().some(item => item.id === summaryModel) ? summaryModel : model;
          summary = await compressOlder(summarizerModel, summary ?? '', extra, abort.signal, this.summarize, this.models().find(item => item.id === summarizerModel)?.contextWindow);
          older = planned.older;
          conversation.summary = summary;
          conversation.summaryUntil = older.at(-1)?.id;
          saveSoon(true);
        }
        reply.contextMessages = recent.length;
        if (older.length) reply.contextNote = `更早的 ${older.filter(message => message.role === 'user').length} 轮已压缩为摘要，仍会参与这次回答`;
        const result = await this.answer({
          contextWindow, contextThreshold: assistant.context.threshold,
          messages: this.modelMessages(conversation.id, recent), ...(summary ? { summary } : {}), model, knowledge: conversation.knowledge,
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
          onTool: call => {
            if (abort.signal.aborted) return;
            reply.toolCalls ??= [];
            const index = reply.toolCalls.findIndex(item => item.id === call.id);
            if (index < 0) reply.toolCalls.push({ ...call }); else reply.toolCalls[index] = { ...call };
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
      } catch (error) { if (opened && !abort.signal.aborted) { reply.status = 'error'; reply.error = error instanceof Error ? error.message : String(error); } }
      finally {
        if (opened) {
          if (abort.signal.aborted) reply.status = 'cancelled';
          for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = abort.signal.aborted ? 'cancelled' : 'error'; call.error = abort.signal.aborted ? '已停止' : reply.error || '工具执行中断'; call.completedAt = new Date().toISOString(); }
          delete reply.stage;
          conversation.updatedAt = new Date().toISOString();
          this.store.save(conversation);
        }
        this.active.delete(id);
        this.acceptance.delete(id);
      }
    })();
    this.active.set(id, { abort, promise }); return conversation;
  }
  cancel(id: string) {
    this.active.get(id)?.abort.abort();
    const conversation = this.get(id); const reply = conversation.messages.at(-1);
    if (reply?.status === 'running') { reply.status = 'cancelled'; delete reply.stage; for (const call of reply.toolCalls ?? []) if (call.status === 'running') { call.status = 'cancelled'; call.completedAt = new Date().toISOString(); } this.store.save(conversation); }
    return conversation;
  }
  async settled(id: string) { await this.active.get(id)?.promise; }
  accepted(id: string): Promise<WorkbenchConversation> {
    const pending = this.acceptance.get(id);
    if (!pending) throw new Error('发送还没有开始');
    return pending;
  }

  private applyEditedAttachments(_conversationId: string, target: WorkbenchMessage, listed: WorkbenchMessage['attachments'], hydrated: boolean) {
    const next = listed ?? [];
    if (hydrated) {
      if (next.length) target.attachments = next;
      else delete target.attachments;
      return;
    }
    const have = new Set((target.attachments ?? []).map(item => item.id));
    const added = next.filter(item => !have.has(item.id));
    if (!added.length) return;
    target.attachments = [...(target.attachments ?? []), ...added];
  }
  private async prepareTurnAttachments(conversation: WorkbenchConversation, flags: { vision: boolean; pdfNative: boolean }, signal: AbortSignal) {
    const items = conversation.messages.flatMap(message => message.attachments ?? []);
    if (!items.length) return;
    for (const item of items) {
      const next = attachmentRead({ name: item.name, mime: item.mime, vision: flags.vision, pdfNative: flags.pdfNative });
      if (item.route === next && (next === 'vision' || next === 'pdf-file' || item.text || item.note)) continue;
      item.route = next;
      if (next === 'vision' || !item.text) delete item.note;
    }
    await enrichAttachments(items, {
      signal,
      read: item => this.store.readAttachment(conversation.id, item.id),
      ...(this.attachmentIo?.ocr ? { ocr: this.attachmentIo.ocr } : {}),
      ...(this.attachmentIo?.office ? { office: this.attachmentIo.office } : {}),
    });
  }
  private dropRemovedAttachments(snapshot: string, conversation: WorkbenchConversation) {
    const previous = JSON.parse(snapshot) as WorkbenchConversation;
    const keep = new Set(conversation.messages.flatMap(message => (message.attachments ?? []).map(item => item.id)));
    for (const message of previous.messages) for (const item of message.attachments ?? []) {
      if (!keep.has(item.id)) this.store.deleteAttachment(conversation.id, item.id);
    }
  }
  private rollback(conversation: WorkbenchConversation, snapshot: string, previousIds: Set<string>) {
    for (const message of conversation.messages) for (const item of message.attachments ?? []) {
      if (!previousIds.has(item.id)) this.store.deleteAttachment(conversation.id, item.id);
    }
    const restored = JSON.parse(snapshot) as WorkbenchConversation;
    conversation.messages = restored.messages;
    conversation.title = restored.title;
    conversation.model = restored.model;
    conversation.knowledge = restored.knowledge;
    conversation.updatedAt = restored.updatedAt;
    if (restored.summary) conversation.summary = restored.summary;
    else delete conversation.summary;
    if (restored.summaryUntil) conversation.summaryUntil = restored.summaryUntil;
    else delete conversation.summaryUntil;
    this.store.save(conversation);
  }
  private modelMessages(conversationId: string, messages: WorkbenchMessage[]): WorkbenchMessage[] {
    return messages.map(message => {
      if (!message.attachments?.length) return message;
      return {
        ...message,
        attachments: message.attachments.map(item => {
          if (item.data || (item.route !== 'vision' && item.route !== 'pdf-file')) return item;
          const bytes = this.store.readAttachment(conversationId, item.id);
          return bytes ? { ...item, data: bytes.toString('base64') } : item;
        }),
      };
    });
  }
}
