import { z } from 'zod';
import { RunAcceptedResponseSchema } from './common.ts';

export const SourceAddResponseSchema = RunAcceptedResponseSchema;
export const SetDefaultSourceResponseSchema = z.object({ sourceId: z.string().min(1) });

export type SourceAddResponse = z.infer<typeof SourceAddResponseSchema>;
export type SetDefaultSourceResponse = z.infer<typeof SetDefaultSourceResponseSchema>;
