import { z } from 'zod';

export const AdvisorSeveritySchema = z.enum(['critical', 'warn', 'info']);

export const AdvisorProductSuggestionSchema = z.object({
  id: z.string(),
  dispatch_id: z.string().optional(),
  severity: AdvisorSeveritySchema,
  title: z.string(),
  detail: z.string().optional(),
  action_label: z.string().nullable(),
  action_kind: z.enum(['embed_stale', 'sync_source', 'dream_orphans', 'restart_required', 'navigate', 'none']),
  navigate: z.string().optional(),
  source_id: z.string().optional(),
}).passthrough();

export const AdvisorProductViewSchema = z.object({
  score: z.number().nullable(),
  status: z.enum(['good', 'ok', 'needs_attention']),
  status_label: z.string(),
  suggestion_count: z.number().int().nonnegative(),
  suggestions: z.array(AdvisorProductSuggestionSchema),
  generated_at: z.string(),
  worst: AdvisorSeveritySchema.nullable(),
}).passthrough();

export const AdvisorReportSchema = z.object({
  version: z.string(),
  generated_at: z.string(),
  worst: AdvisorSeveritySchema.nullable(),
  findings: z.array(z.object({
    id: z.string(),
    severity: AdvisorSeveritySchema,
    title: z.string(),
    detail: z.string().optional(),
    collector: z.string(),
    ask_user: z.boolean(),
    workspace_dependent: z.boolean().optional(),
    fix: z.object({
      command_argv: z.array(z.string()).nullable(),
      dispatch_id: z.string().optional(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();

export const AdvisorAdminResponseSchema = z.object({
  report: AdvisorReportSchema,
  product: AdvisorProductViewSchema,
}).passthrough();

export const AdvisorApplyRequestSchema = z.object({
  dispatch_id: z.string().min(1),
});

export const AdvisorApplyResponseSchema = z.object({
  status: z.enum(['started', 'restart_required', 'navigate', 'unsupported']),
  runId: z.string().optional(),
  kind: z.string().optional(),
  page: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

export type AdvisorAdminResponse = z.infer<typeof AdvisorAdminResponseSchema>;
export type AdvisorApplyResponse = z.infer<typeof AdvisorApplyResponseSchema>;
export type AdvisorProductView = z.infer<typeof AdvisorProductViewSchema>;
export type AdvisorProductSuggestion = z.infer<typeof AdvisorProductSuggestionSchema>;
