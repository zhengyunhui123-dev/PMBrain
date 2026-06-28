// admin-console.ts — Facade entry point for the admin dashboard backend.
//
// This file re-exports the natural-language task module and retains the
// Dashboard / knowledge-base browsing and configuration helpers.
//
// New feature modules should be placed under ./<module-name>/ and re-exported
// here so that serve-http.ts imports remain stable.

import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { isSensitiveConfigKey, redactConfigValue } from './config.ts';
import { loadAllSources, isSourceFederated } from '../core/sources-load.ts';

// ---------------------------------------------------------------------------
// Facade: re-export natural-language task module
// ---------------------------------------------------------------------------

export * from './natural-lang/index.ts';

// ---------------------------------------------------------------------------
// Dashboard / knowledge-base browsing
// ---------------------------------------------------------------------------

function redactedConfig(config: GBrainConfig | null): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      out[key] = redactConfigValue(key, value);
    } else if (isSensitiveConfigKey(key)) {
      out[key] = '***';
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function getAdminBrainOverview(engine: BrainEngine, config: GBrainConfig | null, version: string) {
  const [stats, sources] = await Promise.all([
    engine.getStats(),
    loadAllSources(engine, { includeArchived: true }),
  ]);

  const sourceRows = await Promise.all(sources.map(async (source) => {
    const [count] = await engine.executeRaw<{ page_count: number }>(
      `SELECT COUNT(*)::int AS page_count FROM pages WHERE source_id = $1`,
      [source.id],
    );
    return {
      id: source.id,
      name: source.name,
      local_path: source.local_path,
      federated: isSourceFederated(source.config),
      page_count: count?.page_count ?? 0,
      last_sync_at: source.last_sync_at ? new Date(source.last_sync_at).toISOString() : null,
      archived: source.archived === true,
    };
  }));

  const [recentWrite] = await engine.executeRaw<{ updated_at: string | null }>(
    `SELECT MAX(updated_at)::text AS updated_at FROM pages`,
  );
  const [pendingEmbed] = await engine.executeRaw<{ pending: number }>(
    `SELECT COUNT(*)::int AS pending
       FROM content_chunks
      WHERE embedding IS NULL`,
  );

  const embedded = stats.embedded_count ?? 0;
  const chunks = stats.chunk_count ?? 0;
  const coverage = chunks > 0 ? Math.round((embedded / chunks) * 1000) / 10 : 100;
  const providerStatus = getProviderStatus(config);

  return {
    version,
    engine: config?.engine ?? 'unknown',
    schema_pack: config?.schema_pack ?? 'gbrain-base',
    chat_model: config?.chat_model ?? null,
    embedding_model: config?.embedding_model ?? null,
    embedding_dimensions: config?.embedding_dimensions ?? null,
    expansion_model: config?.expansion_model ?? null,
    stats,
    embedding_coverage: coverage,
    pending_embeddings: pendingEmbed?.pending ?? Math.max(0, chunks - embedded),
    recent_write_at: recentWrite?.updated_at ?? null,
    sources: sourceRows,
    federated_source_count: sourceRows.filter(s => s.federated).length,
    provider_status: providerStatus,
    llm_enabled: providerStatus.chat.enabled,
    config: redactedConfig(config),
  };
}

export async function listAdminBrainPages(
  engine: BrainEngine,
  query: { source?: string; type?: string; q?: string; embedded?: string; page?: string; limit?: string },
) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const requestedLimit = Number.parseInt(query.limit ?? '10', 10) || 10;
  const limit = [10, 20, 40].includes(requestedLimit) ? requestedLimit : 10;
  const offset = (page - 1) * limit;
  const filters: string[] = ['p.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (query.source && query.source !== 'all') {
    params.push(query.source);
    filters.push(`p.source_id = $${params.length}`);
  }
  if (query.type && query.type !== 'all') {
    params.push(query.type);
    filters.push(`p.type = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    filters.push(`(p.slug ILIKE $${params.length} OR p.title ILIKE $${params.length})`);
  }
  if (query.embedded === 'yes') {
    filters.push(`COALESCE(cc.embedded_chunks, 0) = COALESCE(cc.chunk_count, 0) AND COALESCE(cc.chunk_count, 0) > 0`);
  } else if (query.embedded === 'no') {
    filters.push(`COALESCE(cc.embedded_chunks, 0) < COALESCE(cc.chunk_count, 0)`);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const baseSql = `
    FROM pages p
    LEFT JOIN (
      SELECT page_id,
             COUNT(*)::int AS chunk_count,
             COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunks
        FROM content_chunks
       GROUP BY page_id
    ) cc ON cc.page_id = p.id
    ${where}
  `;

  const rows = await engine.executeRaw<{
    id: number;
    slug: string;
    title: string | null;
    source_id: string;
    type: string;
    updated_at: string;
    chunk_count: number;
    embedded_chunks: number;
    tag_count: number;
    frontmatter: unknown;
    preview: string;
  }>(
    `SELECT p.id, p.slug, p.title, p.source_id, p.type, p.updated_at::text AS updated_at,
            COALESCE(cc.chunk_count, 0)::int AS chunk_count,
            COALESCE(cc.embedded_chunks, 0)::int AS embedded_chunks,
            (SELECT COUNT(*)::int FROM tags t WHERE t.page_id = p.id) AS tag_count,
            p.frontmatter,
            LEFT(p.compiled_truth, 8000) AS preview
       ${baseSql}
      ORDER BY p.updated_at DESC, p.slug
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const [count] = await engine.executeRaw<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${baseSql}`,
    params,
  );

  return {
    rows,
    total: count?.total ?? 0,
    page,
    limit,
    pages: Math.max(1, Math.ceil((count?.total ?? 0) / limit)),
  };
}

export async function getAdminBrainPageChunks(engine: BrainEngine, sourceId: string, slug: string) {
  const rows = await engine.executeRaw<{
    id: number;
    chunk_index: number;
    chunk_text: string;
    chunk_source: string;
    token_count: number | null;
    embedded: boolean;
  }>(
    `SELECT c.id,
            c.chunk_index::int AS chunk_index,
            c.chunk_text,
            c.chunk_source,
            c.token_count::int AS token_count,
            (c.embedding IS NOT NULL) AS embedded
       FROM pages p
       JOIN content_chunks c ON c.page_id = p.id
      WHERE p.source_id = $1
        AND p.slug = $2
        AND p.deleted_at IS NULL
      ORDER BY c.chunk_index ASC`,
    [sourceId, slug],
  );

  return { rows };
}

// ---------------------------------------------------------------------------
// Provider status (used by getAdminBrainOverview; also re-exported via natural-lang)
// ---------------------------------------------------------------------------

function getProviderStatus(config: GBrainConfig | null) {
  const chatModel = config?.chat_model ?? null;
  const provider = chatModel?.split(':')[0] ?? null;
  const providers = {
    mimo: !!config?.mimo_api_key,
    zhipu: !!config?.zhipu_api_key,
    deepseek: !!config?.deepseek_api_key,
    openai: !!config?.openai_api_key,
    anthropic: !!config?.anthropic_api_key,
    zeroentropy: !!config?.zeroentropy_api_key,
  };
  const providerKeyMap: Record<string, keyof typeof providers> = {
    mimo: 'mimo',
    zhipu: 'zhipu',
    deepseek: 'deepseek',
    openai: 'openai',
    anthropic: 'anthropic',
    zeroentropyai: 'zeroentropy',
  };
  const required = provider ? providerKeyMap[provider] : null;
  const hasRequired = required ? providers[required] : false;
  return {
    chat: {
      enabled: !!chatModel && hasRequired,
      chat_model: chatModel,
      provider,
      missing: !chatModel ? ['chat_model'] : hasRequired ? [] : [`${provider}_api_key`],
    },
    providers,
  };
}
