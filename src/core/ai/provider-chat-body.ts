export function officialCompletionTokenHost(requestUrl: string): boolean {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    return host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com' || /(?:^|\.)qianwenai(?:api)?\.com$/.test(host);
  } catch {
    return false;
  }
}

export function applyOfficialCompletionTokenField(requestUrl: string, body: Record<string, unknown>): boolean {
  const model = String(body.model ?? '').split('/').at(-1)!.toLowerCase();
  if (!officialCompletionTokenHost(requestUrl) || !/^(?:qwen|qwq|qvq|deepseek)/.test(model) || /(?:embed|rerank|asr|tts)/.test(model)) return false;
  let changed = false;
  if (body.max_completion_tokens == null && body.max_tokens != null) {
    body.max_completion_tokens = body.max_tokens;
    changed = true;
  }
  if ('max_tokens' in body) {
    delete body.max_tokens;
    changed = true;
  }
  return changed;
}

export const officialCompletionTokenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (init?.body && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && applyOfficialCompletionTokenField(requestUrl, parsed)) {
        const headers = new Headers(init.headers ?? {});
        headers.delete('content-length');
        init = { ...init, body: JSON.stringify(parsed), headers };
      }
    } catch { /* 非 JSON 请求保持原样 */ }
  }
  return fetch(input, init);
}) as unknown as typeof fetch;
