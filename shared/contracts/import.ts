import { z } from 'zod';
import { RunAcceptedResponseSchema } from './common.ts';

export const ImportSettingsResponseSchema = z.object({
  bytesBlock: z.number().int().positive(),
  thresholdKb: z.number().int().min(100).max(5000),
  minKb: z.number().int().positive(),
  maxKb: z.number().int().positive(),
});

export const ImportRunResponseSchema = RunAcceptedResponseSchema;
export const ImportUploadRunResponseSchema = RunAcceptedResponseSchema.extend({ fileName: z.string() });

export type ImportSettingsResponse = z.infer<typeof ImportSettingsResponseSchema>;
export type ImportRunResponse = z.infer<typeof ImportRunResponseSchema>;
export type ImportUploadRunResponse = z.infer<typeof ImportUploadRunResponseSchema>;
