import { z } from 'zod';

export const RunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const TaskProductProgressSchema = z.object({
  name: z.string(), stage: z.string(), percent: z.number().min(0).max(100).nullable(),
  phasePercent: z.number().min(0).max(100).nullable(), completedSteps: z.number().int().nonnegative(),
  steps: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(['pending', 'running', 'completed', 'skipped', 'failed']), phases: z.array(z.string()) })),
  processed: z.number().nullable(), total: z.number().nullable(), file: z.string().nullable(),
  metrics: z.array(z.object({ label: z.string(), value: z.number() })), errorReason: z.string().nullable(),
  scope: z.object({ name: z.string(), index: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
});

export const RunAcceptedResponseSchema = z.object({
  runId: z.string().min(1),
  status: RunStatusSchema,
}).passthrough();

export const ConsoleRunSchema = z.object({
  id: z.string(),
  kind: z.string(),
  trigger: z.enum(['manual', 'scheduled']).optional(),
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
  product: TaskProductProgressSchema.optional(),
}).passthrough();

export type RunAcceptedResponse = z.infer<typeof RunAcceptedResponseSchema>;
export type ConsoleRun = z.infer<typeof ConsoleRunSchema>;
