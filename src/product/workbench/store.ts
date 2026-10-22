import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../../core/atomic-write';
import { defaultAssistant, normalizeAssistant, type KnowledgeAssistantSettings, type WorkbenchConversation } from '../../../shared/workbench';
import { smallPreview } from './attachments';
import { activityLine } from './playbook';

export interface WorkbenchConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  assistantId?: string;
  model: string;
  knowledge: boolean;
  primary?: boolean;
  messageCount: number;
  revision: number;
  activity: string;
  generating: boolean;
}
type IndexEntry = { mtimeMs: number; bytes: number; summary: WorkbenchConversationSummary };

const PREVIEW_MAX_CHARS = 12_000;

export class WorkbenchStore {
  constructor(readonly root: string) {}
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话 ID');
    return join(this.root, `${id}.json`);
  }
  private filesDir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话 ID');
    return join(this.root, 'files', id);
  }
  private attachmentPath(conversationId: string, attachmentId: string) {
    if (!/^[a-f0-9-]{36}$/.test(attachmentId)) throw new Error('无效的附件 ID');
    return join(this.filesDir(conversationId), attachmentId);
  }
  get(id: string): WorkbenchConversation {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error('会话不存在');
    const conversation = JSON.parse(readFileSync(path, 'utf8')) as WorkbenchConversation;
    this.overlayLive(conversation);
    for (const message of [...conversation.messages, ...(conversation.revisions ?? []).flatMap(item => item.messages)]) {
      if (message.memory?.hash) {
        const state = this.memoryPath(id, message.id, message.memory.hash);
        if (existsSync(state)) message.memory = JSON.parse(readFileSync(state, 'utf8'));
      }
    }
    return conversation;
  }
  list(): WorkbenchConversation[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => this.get(name.slice(0, -5))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  readAttachment(conversationId: string, attachmentId: string): Buffer | null {
    const path = this.attachmentPath(conversationId, attachmentId);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }
  deleteAttachment(conversationId: string, attachmentId: string) {
    const path = this.attachmentPath(conversationId, attachmentId);
    if (existsSync(path)) unlinkSync(path);
  }
  save(conversation: WorkbenchConversation) {
    conversation.revision = (conversation.revision ?? 0) + 1;
    this.externalize(conversation);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(conversation.id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(conversation), { mode: 0o600 });
    renameSync(temp, target);
    const stat = statSync(target);
    this.rememberSummary(conversation, Math.round(stat.mtimeMs), stat.size);
    this.clearLive(conversation.id);
  }
  noteLive(conversation: WorkbenchConversation) {
    const message = conversation.messages.at(-1);
    if (!message) return;
    mkdirSync(join(this.root, 'live'), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.livePath(conversation.id), JSON.stringify({ message: { id: message.id, text: message.text, ...(message.stage ? { stage: message.stage } : {}), status: message.status } }));
  }
  summaries(): WorkbenchConversationSummary[] {
    if (!existsSync(this.root)) return [];
    const names = readdirSync(this.root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    const current = this.readIndex();
    const next: Record<string, IndexEntry> = {};
    const rows: WorkbenchConversationSummary[] = [];
    let dirty = false;
    for (const name of names) {
      const id = name.slice(0, -5);
      const stat = statSync(join(this.root, name));
      const mtimeMs = Math.round(stat.mtimeMs);
      const bytes = stat.size;
      const cached = current[id];
      if (cached?.mtimeMs === mtimeMs && cached.bytes === bytes && cached.summary?.id === id) {
        next[id] = cached;
        rows.push(cached.summary);
        continue;
      }
      const summary = this.summaryOf(JSON.parse(readFileSync(this.path(id), 'utf8')) as WorkbenchConversation);
      next[id] = { mtimeMs, bytes, summary };
      rows.push(summary);
      dirty = true;
    }
    if (dirty || Object.keys(current).length !== Object.keys(next).length) this.writeIndex(next);
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  remove(id: string) {
    unlinkSync(this.path(id));
    this.clearLive(id);
    this.forgetSummary(id);
    rmSync(this.filesDir(id), { recursive: true, force: true });
    rmSync(join(this.root, 'memory', id), { recursive: true, force: true });
  }
  assistant(): KnowledgeAssistantSettings {
    const path = join(this.root, 'assistant.json');
    if (!existsSync(path)) return defaultAssistant();
    try { return normalizeAssistant(JSON.parse(readFileSync(path, 'utf8'))); } catch { return defaultAssistant(); }
  }
  saveAssistant(input: unknown): KnowledgeAssistantSettings {
    const settings = normalizeAssistant(input);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, 'assistant.json');
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(settings), { mode: 0o600 });
    renameSync(temp, target);
    return settings;
  }
  private writeAttachment(conversationId: string, attachmentId: string, bytes: Buffer) {
    const path = this.attachmentPath(conversationId, attachmentId);
    mkdirSync(this.filesDir(conversationId), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  private externalize(conversation: WorkbenchConversation) {
    for (const message of [...conversation.messages, ...(conversation.revisions ?? []).flatMap(item => item.messages)]) {
      for (const item of message.attachments ?? []) {
        let bytes: Buffer | null = null;
        if (item.data) bytes = Buffer.from(item.data, 'base64');
        else if (item.preview && item.preview.length > PREVIEW_MAX_CHARS) {
          const match = /^data:[^;]+;base64,([\s\S]+)$/.exec(item.preview);
          if (match) bytes = Buffer.from(match[1], 'base64');
        }
        if (bytes?.length) this.writeAttachment(conversation.id, item.id, bytes);
        delete item.data;
        if (item.preview && item.preview.length > PREVIEW_MAX_CHARS) {
          const thumb = bytes ? smallPreview(bytes, item.mime) : undefined;
          if (thumb) item.preview = thumb;
          else delete item.preview;
        }
      }
    }
  }
  private indexPath() { return join(this.root, 'conversation-index.json'); }
  private livePath(id: string) { this.path(id); return join(this.root, 'live', `${id}.json`); }
  private clearLive(id: string) { if (/^[a-f0-9-]{36}$/.test(id) && existsSync(join(this.root, 'live', `${id}.json`))) unlinkSync(join(this.root, 'live', `${id}.json`)); }
  private readLive(id: string) {
    const path = this.livePath(id);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { message?: { id?: string; text?: string; stage?: string } };
      return parsed.message?.id ? parsed.message : null;
    } catch { return null; }
  }
  private overlayLive(conversation: WorkbenchConversation) {
    const live = this.readLive(conversation.id);
    if (!live) return;
    const message = conversation.messages.find(item => item.id === live.id);
    if (!message) return;
    if (typeof live.text === 'string' && live.text.length > message.text.length) message.text = live.text;
    if (live.stage && message.status === 'running') message.stage = live.stage;
  }
  private summaryOf(conversation: WorkbenchConversation): WorkbenchConversationSummary {
    return {
      id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, createdAt: conversation.createdAt,
      ...(conversation.assistantId ? { assistantId: conversation.assistantId } : {}), model: conversation.model, knowledge: conversation.knowledge,
      ...(conversation.primary ? { primary: true } : {}), messageCount: conversation.messages.length, revision: conversation.revision ?? 0,
      activity: activityLine(conversation.messages, false), generating: conversation.messages.some(message => message.status === 'running'),
    };
  }
  private readIndex(): Record<string, IndexEntry> {
    if (!existsSync(this.indexPath())) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath(), 'utf8')) as { entries?: Record<string, IndexEntry> };
      return parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    } catch { return {}; }
  }
  private writeIndex(entries: Record<string, IndexEntry>) {
    if (!existsSync(this.root)) return;
    atomicWriteFileSync(this.indexPath(), JSON.stringify({ entries }));
  }
  private rememberSummary(conversation: WorkbenchConversation, mtimeMs: number, bytes: number) {
    const entries = this.readIndex();
    entries[conversation.id] = { mtimeMs, bytes, summary: this.summaryOf(conversation) };
    this.writeIndex(entries);
  }
  private forgetSummary(id: string) {
    const entries = this.readIndex();
    if (!entries[id]) return;
    delete entries[id];
    this.writeIndex(entries);
  }
  private memoryPath(id: string, messageId: string, hash: string) {
    this.path(id);
    if (!/^[a-f0-9-]{36}$/.test(messageId) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('无效的记忆版本');
    return toNamespacedPath(join(this.root, 'memory', id, `${createHash('sha256').update(`${messageId}:${hash}`).digest('hex')}.json`));
  }
  saveMemory(id: string, messageId: string, memory: NonNullable<WorkbenchConversation['messages'][number]['memory']>, replaceOwner=false) {
    const target = this.memoryPath(id, messageId, memory.hash);
    if(existsSync(target)&&memory.epoch&&!replaceOwner){const current=JSON.parse(readFileSync(target,'utf8'));if(current.epoch&&current.epoch!==memory.epoch)return;}
    mkdirSync(join(this.root, 'memory', id), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(target,JSON.stringify(memory));
    chmodSync(target,0o600);
  }
}
