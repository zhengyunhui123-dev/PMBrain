import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { createReadStream, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { importFromContent } from '../import-file.ts';
import type { BrainEngine } from '../engine.ts';

type Row = Record<string, unknown>;
type Message = { role: 'user' | 'assistant'; text: string; timestamp: string | null };
type ParsedSession = { format: 'codex' | 'grok'; sessionId: string | null; messages: Message[] };

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

function createSessionAccumulator(filename: string) {
  let format: 'codex' | 'grok' | null = null;
  let sessionId: string | null = null;
  const messages: Message[] = [];
  const eventUsers = new Set<string>();
  const desktopUsers = new Set<string>();

  const consume = (row: Row) => {
    let initializesFormat = false;
    if (format === null) {
      if (row.type === 'session_meta') {
        format = 'codex';
        const meta = record(row.payload);
        const id = meta.id ?? meta.session_id;
        if (typeof id !== 'string' || !id.trim()) throw new Error('Codex 会话缺少身份标识');
        sessionId = id;
        initializesFormat = true;
      } else if (basename(filename).toLowerCase() === 'chat_history.jsonl' && row.type === 'system' && typeof row.content === 'string') {
        format = 'grok';
      } else {
        throw new Error('不支持的会话文件：请选择 Codex rollout JSONL 或 Grok chat_history.jsonl');
      }
    }
    let role: Message['role'] | undefined;
    let text = '';
    let userLane: 'event' | 'desktop' | undefined;
    if (format === 'codex') {
      if (row.type === 'session_meta' && !initializesFormat) throw new Error('一个文件不能混合多个 Codex 会话');
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
        if (Array.isArray(row.tool_calls) && row.tool_calls.length) return;
        throw new Error('Grok 助手正文格式无法识别');
      }
      role = 'assistant'; text = row.content;
    }
    if (!role || !text.trim()) return;
    if (text.includes('\u0000')) throw new Error('会话正文包含不支持的空字符');
    if (role === 'user' && userLane) {
      const key = text.trim();
      if (userLane === 'event' && desktopUsers.has(key)) return;
      if (userLane === 'desktop' && eventUsers.has(key)) return;
      (userLane === 'event' ? eventUsers : desktopUsers).add(key);
    }
    const timestamp = format === 'codex' && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))
      ? new Date(row.timestamp).toISOString() : null;
    messages.push({ role, text, timestamp });
  };

  const finish = (): ParsedSession => {
    if (format === null) throw new Error('会话文件没有可导入的记录');
    if (!messages.length) throw new Error('会话文件没有可导入的用户或助手正文');
    return { format, sessionId, messages };
  };
  return { consume, finish };
}

export function parseSessionExport(raw: string, filename: string): ParsedSession {
  const accumulator = createSessionAccumulator(filename);
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try { accumulator.consume(record(JSON.parse(line))); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`会话文件第 ${index + 1} 条记录不是有效 JSON 对象`);
      throw error;
    }
  }
  return accumulator.finish();
}

export async function parseSessionExportFile(filePath: string, filename: string): Promise<ParsedSession & { digest: string }> {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择普通会话文件，不支持链接或目录');
  const accumulator = createSessionAccumulator(filename);
  const hash = createHash('sha256');
  const input = createReadStream(filePath);
  input.on('data', chunk => hash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    if (!line.trim()) continue;
    try { accumulator.consume(record(JSON.parse(line))); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`会话文件第 ${lineNumber} 条记录不是有效 JSON 对象`);
      throw error;
    }
  }
  return { ...accumulator.finish(), digest: hash.digest('hex') };
}

export async function importSessionExport(
  engine: BrainEngine, filePath: string, relativePath: string,
  opts: { noEmbed?: boolean; sourceId?: string } = {},
) {
  const parsed = await parseSessionExportFile(filePath, relativePath);
  const digest = parsed.digest;
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
