export type TranscriptMessage = { role: 'user' | 'assistant'; timestamp: string; text: string };

export type CodexLineResult =
  | { kind: 'session'; sessionId?: string; cwd?: string; startedAt?: string; cliVersion?: string; modelProvider?: string }
  | { kind: 'user'; message: TranscriptMessage }
  | { kind: 'assistant'; message: TranscriptMessage }
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'boundary' }
  | { kind: 'skip' };

function tolerantJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function textFromBlocks(content: unknown, blockType: string): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === blockType && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

export function mapCodexLine(entry: unknown): CodexLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  const payload = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<string, unknown>;
  const lineTs = typeof e.timestamp === 'string' ? e.timestamp : '';
  if (e.type === 'session_meta') {
    return {
      kind: 'session',
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      startedAt: typeof payload.timestamp === 'string' ? payload.timestamp : lineTs || undefined,
      cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : undefined,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : undefined,
    };
  }
  if (e.type === 'compacted') return { kind: 'boundary' };
  if (e.type === 'event_msg' && payload.type === 'user_message') {
    const text = typeof payload.message === 'string' ? payload.message.trim() : '';
    return text ? { kind: 'user', message: { role: 'user', timestamp: lineTs, text } } : { kind: 'skip' };
  }
  if (e.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const text = textFromBlocks(payload.content, 'output_text');
    return text ? { kind: 'assistant', message: { role: 'assistant', timestamp: lineTs, text } } : { kind: 'skip' };
  }
  if (e.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
    const name = typeof payload.name === 'string' && payload.name ? payload.name : null;
    if (!name) return { kind: 'skip' };
    const rawArgs = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
    return { kind: 'tool_call', name, input: tolerantJson(rawArgs) };
  }
  return { kind: 'skip' };
}
