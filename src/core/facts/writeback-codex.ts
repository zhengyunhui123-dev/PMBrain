import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const READ_BUDGET_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const DISCOVERY_CAP = 4096;

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

function roots(): string[] {
  const home = codexHome();
  return [join(home, 'sessions'), join(home, 'archived_sessions')];
}

function contained(path: string, root: string): boolean {
  const file = resolve(path).toLowerCase();
  const base = resolve(root).toLowerCase();
  return file === base || file.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function confine(path: unknown): string | null {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
    return roots().some(root => contained(path, root)) ? path : null;
  } catch {
    return null;
  }
}

function discover(sessionId: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return null;
  let seen = 0;
  let best: { path: string; mtimeMs: number } | null = null;
  const stack = roots().map(path => ({ path, depth: 0 }));
  while (stack.length && seen < DISCOVERY_CAP) {
    const item = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(item.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > DISCOVERY_CAP) break;
      const path = join(item.path, entry.name);
      if (entry.isDirectory() && item.depth < 4) {
        stack.push({ path, depth: item.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes(sessionId)) continue;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path, mtimeMs: stat.mtimeMs };
      } catch {}
    }
  }
  return best?.path ?? null;
}

function readBounded(path: string): string {
  const size = lstatSync(path).size;
  if (size <= READ_BUDGET_BYTES) return readFileSync(path, 'utf8');
  const tailBytes = READ_BUDGET_BYTES - HEAD_BYTES;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const headRead = readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(tailBytes);
    const tailRead = readSync(fd, tail, 0, tailBytes, size - tailBytes);
    return `${head.subarray(0, headRead).toString('utf8')}\n${tail.subarray(0, tailRead).toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

function blockText(content: unknown, type: string): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === type)
    .map(item => (item as Record<string, unknown>).text)
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .join('\n')
    .trim();
}

export function codexSessionUserTurns(payload: Record<string, unknown>): { sessionId: string; turns: string[]; path: string } | null {
  if (payload.hook_event_name !== 'SessionEnd') return null;
  const payloadSessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const path = confine(payload.transcript_path) ?? discover(payloadSessionId);
  if (!path) return null;
  const turns: string[] = [];
  let sessionId = payloadSessionId;
  for (const line of readBounded(path).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
    if (row.type === 'session_meta' && !sessionId && typeof data.session_id === 'string') sessionId = data.session_id;
    if (row.type === 'event_msg' && data.type === 'user_message' && typeof data.message === 'string' && data.message.trim()) {
      turns.push(data.message.trim());
      continue;
    }
    if (row.type !== 'response_item' || data.type !== 'message' || data.role !== 'user') continue;
    const metadata = data.internal_chat_message_metadata_passthrough;
    const kinds = metadata && typeof metadata === 'object'
      ? (metadata as Record<string, unknown>).content_item_kinds
      : null;
    if (!Array.isArray(kinds) || !kinds.includes('user.text')) continue;
    const text = blockText(data.content, 'input_text');
    if (text) turns.push(text);
  }
  if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) sessionId = basename(path, '.jsonl').slice(-128);
  return sessionId && turns.length ? { sessionId, turns: [...new Set(turns)], path } : null;
}
