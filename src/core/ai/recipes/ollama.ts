import type { Recipe } from '../types.ts';

export const ollama: Recipe = {
  id: 'ollama',
  name: 'Ollama (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:11434/v1',
  auth_env: {
    required: [], // Ollama runs unauthenticated locally; users pass `ollama` as the key.
    optional: ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY'],
    setup_url: 'https://ollama.ai',
  },
  touchpoints: {
    expansion: {
      // Desktop ordinary-model saves intentionally route query expansion to
      // the same model as chat. Ollama model ids are installation-specific.
      models: [],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-17',
    },
    chat: {
      // Ollama exposes OpenAI-compatible chat completions. The concrete model
      // list is installation-specific and is discovered from /api/tags by the
      // desktop app, so the recipe intentionally does not hard-code models.
      models: [],
      supports_tools: true,
      // PMBrain routes non-Anthropic subagents through the canonical gateway
      // tool loop, which generates and persists its own stable execution ids.
      // Verified against the local Ollama OpenAI/tool-call surface; individual
      // models that do not implement tools still fail with their native error.
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-17',
    },
    embedding: {
      models: [
        'nomic-embed-text',
        'mxbai-embed-large',
        'all-minilm',
        'qwen3-embedding:0.6b',
        'qwen3-embedding:4b',
        'qwen3-embedding:8b',
      ],
      default_dims: 768, // nomic-embed-text native dim
      // Per-model native dims — Ollama's model list is installation-specific
      // and these models do NOT share default_dims. Without this map, init's
      // dim preflight both (a) resolved every model to 768 and (b) rejected
      // an explicit dim matching the model's true native size, so users of
      // qwen3-embedding:0.6b (1024) could not init at all. All-MiniLM-L6 is
      // 384; qwen3-embedding 0.6b/4b/8b are 1024/2560/4096 (native max).
      model_dims: {
        'nomic-embed-text': 768,
        'mxbai-embed-large': 1024,
        'all-minilm': 384,
        'qwen3-embedding:0.6b': 1024,
        'qwen3-embedding:4b': 2560,
        'qwen3-embedding:8b': 4096,
      },
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-31',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
      // Local Ollama shares CPU/GPU memory across requests. Keep item-count
      // batching and page concurrency conservative, then let the centralized
      // execution profile heal upward after sustained success.
      execution_profile: {
        mode: 'local',
        initial_concurrency: 2,
        min_concurrency: 1,
        max_concurrency: 4,
        initial_batch_items: 12,
        min_batch_items: 8,
        max_batch_items: 16,
        success_window: 8,
      },
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, pull a chat or embedding model, then run `ollama serve`.',
};
