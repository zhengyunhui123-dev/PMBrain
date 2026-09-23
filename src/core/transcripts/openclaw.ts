export type OpenclawLineResult =
  | { kind: 'message'; message: { role: 'user' | 'assistant'; text: string }; toolCalls?: OpenclawToolCall[] }
  | { kind: 'boundary' }
  | { kind: 'session'; id?: string; cwd?: string; startedAt?: string }
  | { kind: 'skip'; toolCalls?: OpenclawToolCall[] };

export interface OpenclawToolCall {
  name: string;
  input: null;
}

export function mapOpenclawLine(entry: unknown): OpenclawLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  if (e.type === 'session') {
    return {
      kind: 'session',
      id: typeof e.id === 'string' ? e.id : undefined,
      cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
      startedAt: typeof e.timestamp === 'string' ? e.timestamp : undefined,
    };
  }
  if (e.type === 'compaction') return { kind: 'boundary' };
  if (e.type !== 'message') return { kind: 'skip' };
  const msg = e.message;
  if (typeof msg !== 'object' || msg === null) return { kind: 'skip' };
  const m = msg as Record<string, unknown>;
  const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
  if (!role) return { kind: 'skip' };
  const content = m.content;
  let text = '';
  const toolCalls: OpenclawToolCall[] = [];
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
      if (b.type === 'toolCall' && typeof b.name === 'string' && b.name) toolCalls.push({ name: b.name, input: null });
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (!text) return toolCalls.length > 0 ? { kind: 'skip', toolCalls } : { kind: 'skip' };
  return { kind: 'message', message: { role, text }, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
}
