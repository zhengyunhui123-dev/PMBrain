/**
 * MEMORY_VERBS v1 write/delete façade, ported from GBrain as an independent
 * registration module. Core entry (`operations.ts`) only spreads these ops.
 *
 * Ports `remember`, `forget`, and the zero-LLM `entity` card.
 * `synthesize` / `context_pack` / `delta` stay out of this module.
 */

import { OperationError } from './operation-error.ts';
import type { Operation } from './operations.ts';

export const MEMORY_VERBS_VERSION = 1;

const FACT_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;
const PROVENANCE_MAX = 500;

function verbError(code: string, message: string, suggestion: string, detail?: string): OperationError {
  const error = new OperationError(code, message, suggestion);
  error.protocolVersion = MEMORY_VERBS_VERSION;
  if (detail !== undefined) error.detail = detail;
  return error;
}

export function parseTtlParam(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw verbError(
      'invalid_params',
      `ttl must be a string, got ${typeof raw}.`,
      'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z".',
    );
  }
  const s = raw.trim();
  if (!s) return null;

  if (/^P(T|\d)/i.test(s) && /^P(?:\d+[YMWD])*(?:T(?:\d+[HMS])+)?$/i.test(s)) {
    throw verbError(
      'invalid_params',
      `ttl "${s}" looks like an ISO-8601 duration, which is not accepted.`,
      'Use the shorthand form instead (e.g. "30d", "12h"), or an absolute ISO 8601 expiry timestamp.',
    );
  }

  const dur = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (dur) {
    const n = parseInt(dur[1], 10);
    const unit = dur[2].toLowerCase();
    const ms =
      unit.startsWith('s') ? n * 1000 :
      unit.startsWith('m') ? n * 60 * 1000 :
      unit.startsWith('h') ? n * 60 * 60 * 1000 :
      n * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return new Date(iso);

  throw verbError(
    'invalid_params',
    `Cannot parse ttl "${s}".`,
    'Pass a duration like "30d" or "12h", or an absolute ISO 8601 timestamp like "2026-07-12T00:00:00Z".',
  );
}

const remember: Operation = {
  name: 'remember',
  description:
    'MEMORY VERB v1: durably save one user-confirmed fact. Call this directly for “记住/记一下/保存这个”; do not route through an Agent memory file. provenance is required.',
  params: {
    fact: { type: 'string', required: true, description: 'One durable fact or preference to remember.' },
    provenance: {
      type: 'string',
      required: true,
      description: 'Where it came from, e.g. “user said in this conversation”.',
    },
    ttl: {
      type: 'string',
      description: 'Optional expiry: 30d, 12h, 45m, or an ISO timestamp.',
    },
    entity: {
      type: 'string',
      description: 'Optional person, company, or project name/slug.',
    },
    kind: {
      type: 'string',
      enum: [...FACT_KINDS],
      description: 'event | preference | commitment | belief | fact.',
    },
    visibility: {
      type: 'string',
      enum: ['world', 'private'],
      description: 'world (default) is shared with connected Agents; private is local-only.',
    },
  },
  mutating: true,
  scope: 'write',
  verb: true,
  handler: async (ctx, p) => {
    const fact = typeof p.fact === 'string' ? p.fact.trim() : '';
    if (!fact) {
      throw verbError(
        'invalid_params',
        'fact must be a non-empty string.',
        'Pass the claim to remember, e.g. fact: "picked Stripe over Adyen — onboarding speed".',
      );
    }
    const provenance = typeof p.provenance === 'string' ? p.provenance.trim() : '';
    if (!provenance) {
      throw verbError(
        'provenance_required',
        'provenance is required and must be non-empty.',
        'Pass where the fact came from, e.g. provenance: "user told me, 2026-08-16".',
      );
    }
    if (provenance.length > PROVENANCE_MAX) {
      throw verbError(
        'invalid_params',
        `provenance exceeds ${PROVENANCE_MAX} chars (got ${provenance.length}).`,
        'Shorten the attribution — provenance is a pointer, not a transcript.',
      );
    }
    const kind = typeof p.kind === 'string' ? p.kind : 'fact';
    if (!FACT_KINDS.includes(kind as (typeof FACT_KINDS)[number])) {
      throw verbError(
        'invalid_params',
        `kind "${kind}" is not a fact kind.`,
        `Use one of: ${FACT_KINDS.join(' | ')}.`,
      );
    }
    const visibility = typeof p.visibility === 'string' ? p.visibility : 'world';
    if (visibility !== 'world' && visibility !== 'private') {
      throw verbError(
        'invalid_params',
        `visibility "${visibility}" is not valid.`,
        'Use "world" (default — agents can recall it) or "private" (local CLI reads only).',
      );
    }
    const validUntil = parseTtlParam(p.ttl);

    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'remember',
        fact,
        protocol_version: MEMORY_VERBS_VERSION,
      };
    }

    const { writeSingleFact } = await import('./facts/write-single.ts');
    const result = await writeSingleFact(ctx.engine, ctx.sourceId ?? 'default', {
      fact,
      provenance,
      kind: kind as (typeof FACT_KINDS)[number],
      entity: typeof p.entity === 'string' && p.entity.trim() ? p.entity.trim() : null,
      visibility,
      validUntil,
    });

    const statusText =
      result.status === 'inserted'
        ? `remembered as fact #${result.id}`
        : result.status === 'duplicate'
          ? `already knew this — kept fact #${result.id}`
          : `updated — fact #${result.id} supersedes the previous version`;

    return {
      id: String(result.id),
      status: result.status,
      status_text: statusText,
      entity_slug: result.entity_slug ?? null,
      valid_until: result.valid_until ? result.valid_until.toISOString() : null,
      ...(result.degraded_dedup ? { degraded_dedup: true } : {}),
      protocol_version: MEMORY_VERBS_VERSION,
    };
  },
  cliHints: { name: 'remember', positional: ['fact'] },
};

const forget: Operation = {
  name: 'forget',
  description:
    'MEMORY VERB v1: expire a remembered fact by the opaque id from remember/recall. Audit history is kept; repeated forget is idempotent.',
  params: {
    id: { type: 'string', required: true, description: 'Opaque fact id from remember or recall.' },
    reason: { type: 'string', description: 'Optional audit reason.' },
  },
  mutating: true,
  scope: 'write',
  verb: true,
  handler: async (ctx, p) => {
    const rawId = typeof p.id === 'string' ? p.id.trim() : typeof p.id === 'number' ? String(p.id) : '';
    const numericId = Number(rawId);
    if (!rawId || !Number.isInteger(numericId) || numericId <= 0) {
      throw verbError(
        'not_found',
        `No fact with id "${String(p.id)}".`,
        'Pass the opaque string id returned by remember or recall (facts[].fact_id) — page slugs are not fact ids.',
      );
    }
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;

    if (ctx.dryRun) {
      return { dry_run: true, action: 'forget', id: rawId, protocol_version: MEMORY_VERBS_VERSION };
    }

    const { forgetFactInFence } = await import('./facts/forget.ts');
    const result = await forgetFactInFence(ctx.engine, numericId, {
      ...(reason ? { reason } : {}),
      sourceId: ctx.sourceId ?? 'default',
      worldOnly: ctx.remote !== false,
    });

    if (!result.ok && result.path === 'not_found') {
      throw verbError(
        'not_found',
        `No fact with id "${rawId}".`,
        'Ids come from remember/recall (facts[].fact_id). recall the entity first to find the right fact.',
      );
    }
    if (!result.ok && result.path === 'already_expired') {
      return {
        id: rawId,
        expired: false,
        reason,
        protocol_version: MEMORY_VERBS_VERSION,
      };
    }

    return {
      id: rawId,
      expired: true,
      reason,
      protocol_version: MEMORY_VERBS_VERSION,
    };
  },
};

const entity: Operation = {
  name: 'entity',
  description:
    'MEMORY VERB (v1): inspect ONE known person/company/project card — zero LLM calls. ' +
    'Resolution: alias > exact title > slug-suffix. NEVER errors on a miss: returns found:false plus near-miss suggestions. ' +
    'Routing: for facts/snippets retrieval use recall; for broad questions needing reasoning use think.',
  params: {
    name: { type: 'string', required: true, description: 'Free-text name, alias, or slug (e.g. "Alice", "people/alice").' },
  },
  scope: 'read',
  verb: true,
  handler: async (ctx, p) => {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) {
      throw verbError(
        'invalid_params',
        'name must be a non-empty string.',
        'Pass the entity to look up, e.g. name: "Alice" or name: "people/alice".',
      );
    }
    const t0 = Date.now();
    const { buildEntityCard } = await import('./verbs/entity-card.ts');
    const result = await buildEntityCard(ctx.engine, ctx.sourceId ?? 'default', name, {
      remote: ctx.remote !== false,
    });
    return {
      protocol_version: MEMORY_VERBS_VERSION,
      found: result.found,
      latency_ms: Date.now() - t0,
      ...(result.card ? { card: result.card } : {}),
      ...(result.suggestions !== undefined ? { suggestions: result.suggestions } : {}),
    };
  },
  cliHints: { name: 'entity', positional: ['name'] },
};

export const memoryVerbOperations: Operation[] = [remember, forget, entity];
