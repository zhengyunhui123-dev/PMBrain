import { z } from 'zod';

export const ProductSurfacePayloadSchema = z.any();

export const GoogleConnectEnvelopeSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  next_action: z.object({
    command: z.string().optional(),
    user_message: z.string().optional(),
  }).passthrough().optional(),
  error: z.object({
    code: z.string(),
    problem: z.string().optional(),
    cause: z.string().optional(),
    fix: z.string().optional(),
    doc_url: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const GoogleConnectRequestSchema = z.object({
  account: z.string().optional(),
  paste: z.boolean().optional(),
  code: z.string().optional(),
  client_json: z.string().optional(),
});

export const GoogleSourceAddRequestSchema = z.object({
  account: z.string().min(1),
  id: z.string().optional(),
});

export const ConnectorSyncRequestSchema = z.object({
  provider: z.string().min(1),
  full: z.boolean().optional(),
  dry_run: z.boolean().optional(),
});

export const WaitingCloseRequestSchema = z.object({
  id: z.number().int(),
  status: z.enum(['done', 'dropped']),
  note: z.string().optional(),
});

export const EntityIdentityLinkRequestSchema = z.object({
  entity_id: z.string().min(1),
  slug: z.string().min(1),
  source_id: z.string().min(1),
  canonical: z.boolean().optional(),
});

export type GoogleConnectEnvelope = z.infer<typeof GoogleConnectEnvelopeSchema>;
export type GoogleConnectRequest = z.infer<typeof GoogleConnectRequestSchema>;
export type GoogleSourceAddRequest = z.infer<typeof GoogleSourceAddRequestSchema>;
export type ConnectorSyncRequest = z.infer<typeof ConnectorSyncRequestSchema>;
export type WaitingCloseRequest = z.infer<typeof WaitingCloseRequestSchema>;
export type EntityIdentityLinkRequest = z.infer<typeof EntityIdentityLinkRequestSchema>;
