import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { importFromContent } from '../import-file.ts';
import type { BrainEngine } from '../engine.ts';

type Row = Record<string, unknown>;
type Message = { role: 'user' | 'assistant'; text: string; timestamp: string | null };

function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话记录必须是 JSON 对象');
  return value as Row;
}

function blocks(value: unknown, kinds: readonly string[]): string {
  if (!Array.isArray(value)) throw new Error('会话正文格式无法识别');
  return value.map(value => {
    const block = record(value);
    if (!kinds.includes(String(block.type))) return '';
    if (typeof block.text !== 'string') throw new Error('会话正文不是文本');
    return block.text;
  }).filter(Boolean).join('\n');
}

function isTypedUserText(payload: Row): boolean {
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const kinds = (meta as Row).content_item_kinds;
  return Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => kind === 'user.text');
}

export function isSessionExportPath(path: string): boolean {
  return extname(path).toLowerCase() === '.jsonl';
}

export function parseSessionExport(raw: string, filename: string): {
  format: 'codex' | 'grok'; sessionId: string | null; messages: Message[];
} {
  const rows = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return record(JSON.parse(line)); }
    catch { throw new Error(`会话文件第 ${i + 1} 条记录不是有效 JSON 对象`); }
  });
  const first = rows[0];
  let format: 'codex' | 'grok';
  let sessionId: string | null = null;
  if (first?.type === 'session_meta') {
    format = 'codex';
    const meta = record(first.payload);
    const id = meta.id ?? meta.session_id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('Codex 会话缺少身份标识');
    sessionId = id;
  } else if (basename(filename).toLowerCase() === 'chat_history.jsonl' && first?.type === 'system' && typeof first.content === 'string') {
    format = 'grok';
  } else {
    throw new Error('不支持的会话文件：请选择 Codex rollout JSONL 或 Grok chat_history.jsonl');
  }
  const messages: Message[] = [];
  const eventUsers = new Set<string>();
  const desktopUsers = new Set<string>();
  for (const row of rows) {
    let role: Message['role'] | undefined;
    let text = '';
    let userLane: 'event' | 'desktop' | undefined;
    if (format === 'codex') {
      if (row.type === 'session_meta' && row !== first) throw new Error('一个文件不能混合多个 Codex 会话');
      const payload = row.payload && typeof row.payload === 'object' ? record(row.payload) : {};
      if (row.type === 'event_msg' && payload.type === 'user_message') {
        if (typeof payload.message !== 'string') throw new Error('Codex 用户正文格式无法识别');
        role = 'user'; text = payload.message; userLane = 'event';
      } else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && isTypedUserText(payload)) {
        role = 'user'; text = blocks(payload.content, ['input_text', 'text']); userLane = 'desktop';
      } else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        role = 'assistant'; text = blocks(payload.content, ['output_text']);
      }
    } else if (row.type === 'user' && !row.synthetic_reason) {
      role = 'user'; text = typeof row.content === 'string' ? row.content : blocks(row.content, ['text']);
    } else if (row.type === 'assistant') {
      if (typeof row.content !== 'string') {
        if (Array.isArray(row.tool_calls) && row.tool_calls.length) continue;
        throw new Error('Grok 助手正文格式无法识别');
      }
      role = 'assistant'; text = row.content;
    }
    if (!role || !text.trim()) continue;
    if (text.includes('\u0000')) throw new Error('会话正文包含不支持的空字符');
    if (role === 'user' && userLane) {
      const key = text.trim();
      if (userLane === 'event' && desktopUsers.has(key)) continue;
      if (userLane === 'desktop' && eventUsers.has(key)) continue;
      (userLane === 'event' ? eventUsers : desktopUsers).add(key);
    }
    const timestamp = format === 'codex' && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))
      ? new Date(row.timestamp).toISOString() : null;
    messages.push({ role, text, timestamp });
  }
  if (!messages.length) throw new Error('会话文件没有可导入的用户或助手正文');
  return { format, sessionId, messages };
}

export async function importSessionExport(
  engine: BrainEngine, filePath: string, relativePath: string,
  opts: { noEmbed?: boolean; sourceId?: string } = {},
) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择普通会话文件，不支持链接或目录');
  if (stat.size > 20 * 1024 * 1024) throw new Error('会话文件超过 20 MB，请先导出较小的会话文件');
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseSessionExport(raw, relativePath);
  const digest = createHash('sha256').update(raw).digest('hex');
  const slug = `conversations/${parsed.format}/${digest}`;
  const meta = {
    type: 'conversation', title: `${parsed.format === 'codex' ? 'Codex' : 'Grok'} 会话`,
    transcript_import: { version: 1, format: parsed.format, session_id: parsed.sessionId, snapshot_sha256: digest,
      message_count: parsed.messages.length, timestamps: parsed.messages.map(m => m.timestamp) },
  };
  const body = parsed.messages.map(m => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.text.split('\n').map(line => `> ${line}`).join('\n')}`).join('\n\n');
  const content = `---\n${Object.entries(meta).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}`;
  return importFromContent(engine, slug, content, {
    ...opts, sourcePath: relativePath, source_kind: 'conversation', ingested_via: 'manual-session-import',
  });
}
