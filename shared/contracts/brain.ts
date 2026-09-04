import { z } from 'zod';

export const SourceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  local_path: z.string().nullable(),
  git_repo: z.boolean(),
  git_has_changes: z.boolean().nullable().optional().default(null),
  federated: z.boolean(),
  page_count: z.number().int().nonnegative(),
  last_sync_at: z.string().nullable(),
  last_git_commit_at: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  archived_at: z.string().nullable().optional(),
  archive_expires_at: z.string().nullable().optional(),
}).passthrough();

export const BrainStatsSchema = z.object({
  page_count: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  embedded_count: z.number().int().nonnegative(),
  link_count: z.number().int().nonnegative(),
  tag_count: z.number().int().nonnegative().optional().default(0),
  timeline_entry_count: z.number().int().nonnegative(),
  pages_by_type: z.record(z.string(), z.number()),
  fact_count: z.number().int().nonnegative().optional(),
  active_fact_count: z.number().int().nonnegative().optional(),
}).passthrough();

export const BrainOverviewResponseSchema = z.object({
  version: z.string(),
  engine: z.string(),
  schema_pack: z.string(),
  chat_model: z.string().nullable(),
  embedding_model: z.string().nullable(),
  embedding_dimensions: z.number().int().positive().nullable(),
  expansion_model: z.string().nullable(),
  stats: BrainStatsSchema,
  embedding_coverage: z.number(),
  pending_embeddings: z.number().int().nonnegative(),
  pages_added_last_update: z.number().int().nonnegative().optional().default(0),
  pages_removed_last_update: z.number().int().nonnegative().optional().default(0),
  embedding_coverage_delta: z.number().nullable().optional().default(null),
  recent_write_at: z.string().nullable(),
  sources: z.array(SourceSummarySchema),
  main_source_id: z.string(),
  federated_source_count: z.number().int().nonnegative(),
  provider_status: z.object({
    providers: z.record(z.string(), z.boolean()),
    chat: z.object({
      enabled: z.boolean(),
      chat_model: z.string().nullable(),
      provider: z.string().nullable(),
      missing: z.array(z.string()),
    }).passthrough(),
  }).passthrough(),
  llm_enabled: z.boolean(),
  llm_configured: z.boolean().optional(),
  generative_enabled: z.boolean().optional(),
  llm_status_label: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
}).passthrough();

export const BrainPageRowSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  title: z.string().nullable(),
  source_id: z.string(),
  type: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  chunk_count: z.number().int().nonnegative(),
  embedded_chunks: z.number().int().nonnegative(),
  tag_count: z.number().int().nonnegative(),
  frontmatter: z.unknown(),
  preview: z.string(),
}).passthrough();

export const BrainPagesResponseSchema = z.object({
  rows: z.array(BrainPageRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  pages: z.number().int().positive(),
});

export const BrainPageDetailResponseSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  title: z.string(),
  source_id: z.string(),
  source_name: z.string().nullable(),
  source_path: z.string().nullable(),
  type: z.string(),
  page_kind: z.string(),
  compiled_truth: z.string(),
  timeline: z.string(),
  frontmatter: z.unknown(),
  source_kind: z.string().nullable(),
  source_uri: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  takes: z.array(z.object({
    row_num: z.number().int(), claim: z.string(), kind: z.string(), holder: z.string(),
    weight: z.number(), source: z.string().nullable(),
  }).passthrough()),
  facts: z.array(z.object({
    id: z.coerce.number().int(),
    fact: z.string(),
    kind: z.string(),
    visibility: z.string(),
    notability: z.string().optional(),
    entity_slug: z.string().nullable().optional(),
    source: z.string(),
    source_markdown_slug: z.string().nullable().optional(),
    event_type: z.string().nullable().optional(),
    confidence: z.preprocess(value => value == null || value === '' ? undefined : Number(value), z.number().optional()),
    expired_at: z.string().nullable().optional(),
    created_at: z.string().optional(),
  }).passthrough()).optional().default([]),
}).passthrough();

const adminBool = z.preprocess((value) => {
  if (value === true || value === 't' || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'f' || value === 'false' || value === 0 || value === '0') return false;
  return value;
}, z.boolean());

export const BrainFactRowSchema = z.object({
  id: z.coerce.number().int(),
  fact: z.string(),
  kind: z.string(),
  source_id: z.string(),
  entity_slug: z.string().nullable(),
  visibility: z.string(),
  notability: z.string().optional(),
  source: z.string(),
  source_markdown_slug: z.string().nullable().optional(),
  event_type: z.string().nullable().optional(),
  confidence: z.preprocess(value => value == null || value === '' ? undefined : Number(value), z.number().optional()),
  embedded: adminBool,
  expired_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
}).passthrough();

export const BrainFactsResponseSchema = z.object({
  rows: z.array(BrainFactRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  pages: z.number().int().positive(),
});

export const BrainFactDetailResponseSchema = BrainFactRowSchema.extend({
  context: z.string().nullable().optional(),
  source_session: z.string().nullable().optional(),
  valid_from: z.string().optional(),
  valid_until: z.string().nullable().optional(),
}).passthrough();

export const BrainPageChunkSchema = z.object({
  id: z.number().int(),
  chunk_index: z.number().int(),
  chunk_text: z.string(),
  chunk_source: z.string(),
  token_count: z.number().int().nullable(),
  embedded: z.boolean(),
}).passthrough();

export const BrainPageChunksResponseSchema = z.object({ rows: z.array(BrainPageChunkSchema) });

export const KnowledgeGraphNodeSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  title: z.string(),
  source_id: z.string(),
  source_name: z.string().nullable(),
  type: z.string(),
  preview: z.string(),
  tags: z.array(z.string()),
  updated_at: z.string(),
  outgoing_count: z.number().int().nonnegative(),
  incoming_count: z.number().int().nonnegative(),
  relation_count: z.number().int().nonnegative(),
});

export const KnowledgeGraphEdgeSchema = z.object({
  id: z.number().int().positive(),
  from_page_id: z.number().int().positive(),
  to_page_id: z.number().int().positive(),
  link_type: z.string(),
  context: z.string(),
  link_source: z.string().nullable(),
});

export const KnowledgeGraphSearchResponseSchema = z.object({
  rows: z.array(KnowledgeGraphNodeSchema),
});

export const KnowledgeGraphNeighborhoodResponseSchema = z.object({
  center_id: z.number().int().positive(),
  nodes: z.array(KnowledgeGraphNodeSchema),
  edges: z.array(KnowledgeGraphEdgeSchema),
  truncated: z.boolean(),
  limit: z.number().int().positive(),
});

export const KnowledgeGraphMetaResponseSchema = z.object({
  relation_types: z.array(z.string()),
  seed: KnowledgeGraphNodeSchema.nullable(),
});

export const KnowledgeGraphGlobalResponseSchema = z.object({
  nodes: z.array(KnowledgeGraphNodeSchema),
  edges: z.array(KnowledgeGraphEdgeSchema),
  total_nodes: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
  truncated: z.boolean(),
  node_limit: z.number().int().positive(),
  edge_limit: z.number().int().positive(),
});

export type SourceSummary = z.infer<typeof SourceSummarySchema>;
export type BrainOverviewResponse = z.infer<typeof BrainOverviewResponseSchema>;
export type BrainPageRow = z.infer<typeof BrainPageRowSchema>;
export type BrainPagesResponse = z.infer<typeof BrainPagesResponseSchema>;
export type BrainPageDetailResponse = z.infer<typeof BrainPageDetailResponseSchema>;
export type BrainPageChunk = z.infer<typeof BrainPageChunkSchema>;
export type BrainPageChunksResponse = z.infer<typeof BrainPageChunksResponseSchema>;
export type KnowledgeGraphNode = z.infer<typeof KnowledgeGraphNodeSchema>;
export type KnowledgeGraphEdge = z.infer<typeof KnowledgeGraphEdgeSchema>;
export type KnowledgeGraphSearchResponse = z.infer<typeof KnowledgeGraphSearchResponseSchema>;
export type KnowledgeGraphNeighborhoodResponse = z.infer<typeof KnowledgeGraphNeighborhoodResponseSchema>;
export type KnowledgeGraphMetaResponse = z.infer<typeof KnowledgeGraphMetaResponseSchema>;
export type KnowledgeGraphGlobalResponse = z.infer<typeof KnowledgeGraphGlobalResponseSchema>;
export type BrainFactRow = z.infer<typeof BrainFactRowSchema>;
export type BrainFactsResponse = z.infer<typeof BrainFactsResponseSchema>;
export type BrainFactDetailResponse = z.infer<typeof BrainFactDetailResponseSchema>;
