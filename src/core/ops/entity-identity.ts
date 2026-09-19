/**
 * Entity identity ops (federation v1, MANUAL-ONLY).
 *
 * Three ops over the entity_identities table (migration 127):
 *   - entity_identity_link   (write, localOnly) — link a page into a group
 *   - entity_identity_unlink (write, localOnly) — remove a page from a group
 *   - entity_identity_list   (read)             — inspect groups/members
 *
 * The identity KEY is (source_id, slug). There is NO auto-matching in
 * v1: every row is an explicit human assertion, which is why the write ops
 * are localOnly (identity merges change what retrieval unions together
 * across sources — too sharp for a remote agent surface in v1).
 *
 * Read scoping: entity_identity_list honors a federated grant
 * (ctx.auth.allowedSources) and a remote scalar scope by restricting MEMBER
 * visibility. A trusted local caller sees the full cross-source group even
 * when a scalar scope is set — cross-source IS the feature.
 */

import type { Operation, OperationContext } from './contract.ts';
import { OperationError } from './contract.ts';
import {
  linkEntityIdentity,
  unlinkEntityIdentity,
  listEntityIdentities,
} from '../entity-identity.ts';
import { validateSourceId } from '../utils.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';

function identityReadScope(ctx: OperationContext): string[] | undefined {
  const allowed = ctx.auth?.allowedSources;
  if (allowed && allowed.length > 0) return allowed;
  if (ctx.remote !== false && ctx.sourceId) return [ctx.sourceId];
  return undefined;
}

function resolveWriteSourceId(ctx: OperationContext, p: Record<string, unknown>): string {
  const sourceId = (p.source_id as string | undefined) ?? ctx.sourceId ?? 'default';
  validateSourceId(sourceId);
  return sourceId;
}

function assertLocalOnlyWrite(ctx: OperationContext, opName: string): void {
  if (ctx.remote !== false && ctx.transport !== 'stdio') {
    throw new OperationError(
      'permission_denied',
      `${opName} is local-only — call via the pmbrain CLI or stdio MCP.`,
    );
  }
}

const entity_identity_link: Operation = {
  name: 'entity_identity_link',
  description:
    'Link a page into a cross-source entity identity group (v1 manual-only; no auto-matching). ' +
    'The identity key is (source_id, slug); a page belongs to at most one group and re-linking moves it. ' +
    'Set canonical=true to mark the group\'s primary page (demotes any previous canonical).',
  params: {
    entity_id: { type: 'string', required: true, description: "Opaque identity handle grouping the members, e.g. 'alice-chen'. Lowercase [a-z0-9._/-], max 128 chars." },
    slug: { type: 'string', required: true, description: 'Slug of the member page to link.' },
    source_id: { type: 'string', description: "Source the member page lives in. Defaults to the routed source ('default')." },
    confidence: { type: 'number', description: 'Assertion confidence in [0,1]. Default 1.0 (manual assertions are certain).' },
    canonical: { type: 'boolean', description: "Mark this member as the identity's canonical/primary page (at most one per group)." },
  },
  mutating: true,
  scope: 'write',
  localOnly: true,
  cliHints: { name: 'entity-identity-link', positional: ['entity_id', 'slug'] },
  handler: async (ctx, p) => {
    assertLocalOnlyWrite(ctx, 'entity_identity_link');
    const sourceId = resolveWriteSourceId(ctx, p);
    if (ctx.dryRun) {
      return { dry_run: true, action: 'entity_identity_link', entity_id: p.entity_id, slug: p.slug, source_id: sourceId };
    }
    const member = await linkEntityIdentity(ctx.engine, {
      entityId: p.entity_id as string,
      slug: p.slug as string,
      sourceId,
      confidence: p.confidence as number | undefined,
      canonical: p.canonical as boolean | undefined,
      establishedBy: 'manual',
    });
    return { linked: true, member };
  },
};

const entity_identity_unlink: Operation = {
  name: 'entity_identity_unlink',
  description: 'Remove a page from a cross-source entity identity group (v1 manual-only).',
  params: {
    entity_id: { type: 'string', required: true, description: 'Identity handle the member currently belongs to.' },
    slug: { type: 'string', required: true, description: 'Slug of the member page to unlink.' },
    source_id: { type: 'string', description: "Source the member page lives in. Defaults to the routed source ('default')." },
  },
  mutating: true,
  scope: 'write',
  localOnly: true,
  cliHints: { name: 'entity-identity-unlink', positional: ['entity_id', 'slug'] },
  handler: async (ctx, p) => {
    assertLocalOnlyWrite(ctx, 'entity_identity_unlink');
    const sourceId = resolveWriteSourceId(ctx, p);
    if (ctx.dryRun) {
      return { dry_run: true, action: 'entity_identity_unlink', entity_id: p.entity_id, slug: p.slug, source_id: sourceId };
    }
    const removed = await unlinkEntityIdentity(ctx.engine, {
      entityId: p.entity_id as string,
      slug: p.slug as string,
      sourceId,
    });
    return { unlinked: removed, entity_id: p.entity_id, slug: p.slug, source_id: sourceId };
  },
};

const entity_identity_list: Operation = {
  name: 'entity_identity_list',
  description:
    'List cross-source entity identity groups and their member pages. Filter by entity_id or by a member slug. ' +
    'Federated callers only see members in sources their grant covers.',
  params: {
    entity_id: { type: 'string', description: 'Restrict to one identity group.' },
    slug: { type: 'string', description: 'Restrict to the group(s) containing a page with this slug.' },
  },
  scope: 'read',
  cliHints: { name: 'entity-identity-list' },
  handler: async (ctx, p) => {
    const members = await listEntityIdentities(ctx.engine, {
      entityId: p.entity_id as string | undefined,
      slug: p.slug as string | undefined,
      allowedSources: identityReadScope(ctx),
      excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote),
    });
    const groups = new Map<string, typeof members>();
    for (const m of members) {
      const g = groups.get(m.entity_id) ?? [];
      g.push(m);
      groups.set(m.entity_id, g);
    }
    return {
      identities: [...groups.entries()].map(([entity_id, ms]) => ({
        entity_id,
        canonical: ms.find(m => m.canonical) ?? null,
        members: ms,
      })),
    };
  },
};

export const entityIdentityOperations: Operation[] = [
  entity_identity_link,
  entity_identity_unlink,
  entity_identity_list,
];
