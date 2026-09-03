export interface OllamaNativeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaNativeChatInput {
  baseURL: string;
  model: string;
  messages: OllamaNativeMessage[];
  maxTokens: number;
  contextWindow?: number;
  apiKey?: string;
  headers?: Record<string, string>;
  format?: unknown;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface OllamaNativeChatResult {
  content: Array<{ type: 'text'; text: string }>;
  text: string;
  toolCalls: never[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  providerMetadata: Record<string, unknown>;
}

function salvageQuotedField(src: string, key: string): string | null {
  const keyIdx = src.indexOf(`"${key}"`);
  if (keyIdx === -1) return null;
  let i = keyIdx + key.length + 2;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== ':') return null;
  i++;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== '"') return null;
  i++;
  let raw = '';
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      raw += c + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') break;
    raw += c;
  }
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(raw)) raw = raw.slice(0, -1);
  raw = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export function unwrapOllamaQwenResult(text: string, jsonResponse: boolean): string {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown };
    if (parsed.result === undefined || (!jsonResponse && typeof parsed.result !== 'string')) {
      throw new Error('Ollama Qwen3 chat did not return the required result envelope');
    }
    return typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    if (!jsonResponse) {
      const salvaged = salvageQuotedField(trimmed, 'result');
      return salvaged && salvaged.trim() ? salvaged : trimmed;
    }
    const answer = salvageQuotedField(trimmed, 'answer');
    if (answer && answer.trim()) {
      return JSON.stringify({ answer, citations: [], gaps: [] });
    }
    return trimmed;
  }
}

export function ollamaNativeChatUrl(baseURL: string): string {
  const url = new URL(baseURL);
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1')) path = path.slice(0, -3);
  url.pathname = path.endsWith('/api') ? `${path}/chat` : `${path}/api/chat`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function messagesWithThinkingDisabled(
  model: string,
  messages: OllamaNativeMessage[],
): OllamaNativeMessage[] {
  const copy = messages.map(message => ({ ...message }));
  if (!/^qwen3(?:[.:-]|$)/i.test(model)) return copy;
  for (let index = copy.length - 1; index >= 0; index--) {
    const message = copy[index]!;
    if (message.role !== 'user') continue;
    if (!/(?:^|\n)\/no_think\s*$/i.test(message.content)) {
      message.content = `${message.content}\n/no_think`;
    }
    break;
  }
  return copy;
}

export async function streamOllamaNativeChat(
  input: OllamaNativeChatInput,
): Promise<OllamaNativeChatResult> {
  const headers = new Headers(input.headers ?? {});
  headers.set('Content-Type', 'application/json');
  if (input.apiKey && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${input.apiKey}`);
  }
  const response = await fetch(ollamaNativeChatUrl(input.baseURL), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: input.model,
      messages: messagesWithThinkingDisabled(input.model, input.messages),
      stream: true,
      think: false,
      ...(input.format === undefined ? {} : { format: input.format }),
      options: {
        num_predict: input.maxTokens,
        ...(input.contextWindow === undefined ? {} : { num_ctx: input.contextWindow }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      },
    }),
    signal: input.abortSignal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama chat failed: HTTP ${response.status} ${body.slice(0, 180)}`);
  }
  if (!response.body) throw new Error('Ollama chat returned an empty response');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let thinking = '';
  let finishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  let providerMetadata: Record<string, unknown> = { ollama: {} };
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as {
      error?: string;
      message?: { content?: string; thinking?: string };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
      total_duration?: number;
      load_duration?: number;
      prompt_eval_duration?: number;
      eval_duration?: number;
    };
    if (chunk.error) throw new Error(`Ollama chat failed: ${chunk.error}`);
    if (typeof chunk.message?.content === 'string') text += chunk.message.content;
    if (typeof chunk.message?.thinking === 'string') thinking += chunk.message.thinking;
    if (typeof chunk.done_reason === 'string' && chunk.done_reason) finishReason = chunk.done_reason;
    if (typeof chunk.prompt_eval_count === 'number') inputTokens = chunk.prompt_eval_count;
    if (typeof chunk.eval_count === 'number') outputTokens = chunk.eval_count;
    if (chunk.total_duration !== undefined) {
      providerMetadata = {
        ollama: {
          totalDurationNs: chunk.total_duration,
          loadDurationNs: chunk.load_duration,
          promptEvalDurationNs: chunk.prompt_eval_duration,
          evalDurationNs: chunk.eval_duration,
        },
      };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(pending);

  const finalText = text.trim() ? text : thinking;
  return {
    content: finalText ? [{ type: 'text', text: finalText }] : [],
    text: finalText,
    toolCalls: [],
    finishReason,
    usage: { inputTokens, outputTokens },
    providerMetadata,
  };
}
