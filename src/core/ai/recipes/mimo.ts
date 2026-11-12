import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';

export function applyMimoChatCompletionBody(body: Record<string, unknown>): boolean {
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

const mimoChatFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && applyMimoChatCompletionBody(parsed)) {
        const headers = new Headers(init.headers ?? {});
        headers.delete('content-length');
        init = { ...init, body: JSON.stringify(parsed), headers };
      }
    } catch { /* 非 JSON 请求保持原样 */ }
  }
  return fetch(input, init);
}) as unknown as typeof fetch;

/**
 * MIMO (小米开放平台). OpenAI-compatible API endpoint.
 * Supports chat and embedding via OpenAI-compatible format.
 */
export const mimo: Recipe = {
  id: 'mimo',
  name: 'MIMO (小米开放平台)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.xiaomimimo.com/v1',
  auth_env: {
    required: ['MIMO_API_KEY'],
    optional: ['OPENAI_API_KEY'],
    setup_url: 'https://platform.xiaomimimo.com',
  },
  resolveAuth(env) {
    const key = env.MIMO_API_KEY || env.OPENAI_API_KEY;
    if (!key) {
      throw new AIConfigError(
        'MIMO requires MIMO_API_KEY.',
        'Add `mimo_api_key` to ~/.gbrain/config.json or set MIMO_API_KEY.',
      );
    }
    return { headerName: 'Authorization', token: `Bearer ${key}` };
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-small', 'text-embedding-3-large'],
      default_dims: 1536,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-06-02',
      max_batch_tokens: 100_000,
    },
    expansion: {
      models: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.5'],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-06-02',
    },
    chat: {
      models: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.5'],
      thinking_by_default: model => /^mimo-v2\.(?:5|6)(?:-|$)/.test(model),
      supports_vision: true,
      vision_models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_output_tokens: model => /^mimo-v2\.6-(?:flash|pro(?:-ultraspeed)?)$/.test(model) || model === 'mimo-v2.5-pro' ? 131072 : model === 'mimo-v2.5' ? 32768 : undefined,
      max_context_tokens: 128000,
      price_last_verified: '2026-06-02',
    },
  },
  setup_hint: 'Get an API key at https://platform.xiaomimimo.com, then add `mimo_api_key` to ~/.gbrain/config.json or set MIMO_API_KEY.',
  compat: { fetch: mimoChatFetch },
};
