export interface OllamaNativeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaNativeChatInput {
  baseURL: string;
  model: string;
  messages: OllamaNativeMessage[];
  maxTokens: number;
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
  let finishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  let providerMetadata: Record<string, unknown> = { ollama: {} };
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as {
      error?: string;
      message?: { content?: string };
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

  return {
    content: text ? [{ type: 'text', text }] : [],
    text,
    toolCalls: [],
    finishReason,
    usage: { inputTokens, outputTokens },
    providerMetadata,
  };
}
