/**
 * Tolerant JSON decoder for structured LLM output. Raw output is always tried
 * first; reasoning blocks are stripped only after the original payload fails.
 */
export function stripReasoningBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

export function parseLlmJson<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const direct = parseLlmJsonInner<T>(raw, opts);
  if (direct !== null) return direct;
  const stripped = stripReasoningBlocks(raw);
  if (stripped && stripped !== raw.trim()) return parseLlmJsonInner<T>(stripped, opts);
  return null;
}

function parseLlmJsonInner<T>(raw: string, opts: { array?: boolean }): T | null {
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const cleaned = (fence ? fence[1] : raw).trim();
  try {
    const value = JSON.parse(cleaned);
    if (opts.array ? Array.isArray(value) : value !== null && typeof value === 'object') {
      return value as T;
    }
  } catch {
    // Continue with an embedded-object/array scan.
  }
  const match = cleaned.match(opts.array ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    if (opts.array ? Array.isArray(value) : value !== null && typeof value === 'object') {
      return value as T;
    }
  } catch {
    // Malformed model output remains a normal parse miss.
  }
  return null;
}
