/**
 * Scope resolvers for the operations layer. sourceScopeOpts is the canonical
 * read-side source ladder; readPolicyOpts adds page-visibility for untrusted
 * callers. Extracted so ops/chronicle.ts can import them without a cycle
 * through operations.ts.
 */

import type { OperationContext } from './contract.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';

/**
 * v0.34.1 (#861, D9 — P0 leak seal): resolve the source-scope filter for a
 * read-side op handler. Returns an opts fragment ready to spread into the
 * engine call.
 *
 * Precedence:
 *  1. `ctx.auth?.allowedSources` (federated read, #876) → emits
 *     `{sourceIds: [...]}`. Federated semantics subsume the scalar case.
 *  2. `ctx.sourceId` (scalar) → emits `{sourceId: '...'}`.
 *  3. Neither set → emits `{}`. Local CLI callers (and tests that don't
 *     populate ctx) keep the pre-v0.34 unscoped behavior.
 *
 * Both fields default to the engine's "no filter" behavior individually,
 * so unset values are safe — the engine sees the same shape it did
 * pre-v0.34. The leak this guards against is an authenticated MCP client
 * whose ctx.sourceId IS set but whose engine call was constructed without
 * threading it.
 *
 * Helper rather than inline so every read-side handler routes through the
 * same precedence ladder — drift between sites is the bug class.
 */
export function sourceScopeOpts(ctx: OperationContext): { sourceId?: string; sourceIds?: string[] } {
  const allowed = ctx.auth?.allowedSources;
  // Treat an empty `allowedSources: []` as "no federated read scope" — the
  // op-handler defers to scalar `ctx.sourceId` below. An attacker-controlled
  // value of `[]` MUST NOT widen scope to "all sources" by being interpreted
  // as "no filter."
  if (allowed && allowed.length > 0) return { sourceIds: allowed };
  if (ctx.sourceId) return { sourceId: ctx.sourceId };
  return {};
}

/** Resolve policy once at the operation boundary; callers may supply a canonical per-call scope. */
export async function readPolicyOpts(
  ctx: OperationContext,
  scope: { sourceId?: string; sourceIds?: string[] } = sourceScopeOpts(ctx),
): Promise<{ sourceId?: string; sourceIds?: string[]; excludePrivate: boolean }> {
  return {
    ...scope,
    excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote),
  };
}
