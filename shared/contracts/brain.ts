import { z } from 'zod';

export const SourceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  local_path: z.string().nullable(),
  git_repo: z.boolean(),
  federated: z.boolean(),
  page_count: z.number().int().nonnegative(),
  last_sync_at: z.string().nullable(),
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

export type SourceSummary = z.infer<typeof SourceSummarySchema>;
export type BrainOverviewResponse = z.infer<typeof BrainOverviewResponseSchema>;
export type BrainPageRow = z.infer<typeof BrainPageRowSchema>;
export type BrainPagesResponse = z.infer<typeof BrainPagesResponseSchema>;
export type BrainPageDetailResponse = z.infer<typeof BrainPageDetailResponseSchema>;
export type BrainPageChunk = z.infer<typeof BrainPageChunkSchema>;
export type BrainPageChunksResponse = z.infer<typeof BrainPageChunksResponseSchema>;
