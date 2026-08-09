import { z } from 'zod';

export const RunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

export const RunAcceptedResponseSchema = z.object({
  runId: z.string().min(1),
  status: RunStatusSchema,
}).passthrough();

export const ConsoleRunSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: RunStatusSchema,
  command: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  result: z.unknown().optional(),
}).passthrough();

export type RunAcceptedResponse = z.infer<typeof RunAcceptedResponseSchema>;
export type ConsoleRun = z.infer<typeof ConsoleRunSchema>;
