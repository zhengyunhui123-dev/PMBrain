import { z } from 'zod';

export const UpdatePhaseSchema = z.enum([
  'disabled', 'idle', 'checking', 'available', 'downloading', 'downloaded',
  'installing', 'up-to-date', 'error',
]);

export const UpdateStateSchema = z.object({
  phase: UpdatePhaseSchema,
  currentVersion: z.string(),
  availableVersion: z.string().optional(),
  releaseDate: z.string().optional(),
  releaseNotes: z.string().optional(),
  fileName: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  transferred: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  message: z.string(),
});

export type UpdatePhase = z.infer<typeof UpdatePhaseSchema>;
export type UpdateState = z.infer<typeof UpdateStateSchema>;
