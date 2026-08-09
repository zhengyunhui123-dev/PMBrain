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
export const ImportRunRequestSchema = z.object({
  path: z.string().trim().min(1),
  sourceId: z.string().trim().min(1).optional(),
  includeOffice: z.boolean().default(true),
  includeImages: z.boolean().default(false),
  autoEmbed: z.boolean().default(true),
  structuredDocuments: z.boolean().default(true),
  documentOcr: z.boolean().default(false),
  workers: z.number().int().min(1).max(8).default(1),
});
export const ImportUploadOptionsSchema = ImportRunRequestSchema.omit({ path: true, includeOffice: true, includeImages: true });

export type ImportSettingsResponse = z.infer<typeof ImportSettingsResponseSchema>;
export type ImportRunResponse = z.infer<typeof ImportRunResponseSchema>;
export type ImportUploadRunResponse = z.infer<typeof ImportUploadRunResponseSchema>;
export type ImportRunRequest = z.infer<typeof ImportRunRequestSchema>;
export type ImportUploadOptions = z.infer<typeof ImportUploadOptionsSchema>;
