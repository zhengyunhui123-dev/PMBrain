import { z } from 'zod';

export const LlmStatusResponseSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  generative_enabled: z.boolean(),
  chatModel: z.string().nullable(),
  provider: z.string().nullable(),
  providersConfigured: z.record(z.string(), z.boolean()),
  missing: z.array(z.string()),
  status_label: z.string(),
}).passthrough();

export const GenerativeUsageResponseSchema = z.object({
  generative_enabled: z.boolean(),
  capabilities: z.record(z.string(), z.boolean()),
  phase_capabilities: z.array(z.record(z.string(), z.unknown())),
  chat_model: z.string().nullable(),
  stopped_runs: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string() })).optional(),
}).passthrough();

export type LlmStatusResponse = z.infer<typeof LlmStatusResponseSchema>;
export type GenerativeUsageResponse = z.infer<typeof GenerativeUsageResponseSchema>;
