import type { BrainEngine } from './engine.ts';

/** The existing Admin/API row shape, reused verbatim by MCP operations. */
export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  status: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  model_id: string;
  proposed_at: string;
  acted_at: string | null;
  acted_by: string | null;
  promoted_row_num: number | null;
  existing_take_count: number;
}

export type TakeProposalErrorCode =
  | 'invalid_id'
  | 'not_found'
  | 'already_acted'
  | 'source_page_not_found'
  | 'canonical_conflict';

export class TakeProposalError extends Error {
  constructor(
    public readonly code: TakeProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TakeProposalError';
  }
}

export interface TakeProposalReadOptions {
  status?: string;
  limit?: number;
  sourceId?: string;
  sourceIds?: string[];
}

export interface TakeProposalActionOptions {
  actedBy?: string;
  /** Omit only for the trusted, brain-wide Admin API. MCP always supplies ctx.sourceId. */
  sourceId?: string;
}

const TAKE_PROPOSAL_STATUSES = new Set(['pending', 'accepted', 'rejected', 'superseded', 'all']);

function normalizeTakeProposalStatus(status: unknown): string {
  const raw = typeof status === 'string' && status.trim() ? status.trim() : 'pending';
  return TAKE_PROPOSAL_STATUSES.has(raw) ? raw : 'pending';
}

function validateProposalId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TakeProposalError('invalid_id', 'take proposal id must be a positive integer');
  }
}

function scopedNotFoundMessage(sourceId?: string): string {
  return sourceId
    ? `take proposal not found in source scope "${sourceId}"`
    : 'take proposal not found';
}

/**
 * Shared list implementation. Admin callers intentionally omit source scope;
 * Operation callers always pass the canonical read scope resolved by
 * sourceScopeOpts/requestedSourceScopeOpts.
 */
export async function listTakeProposals(
  engine: BrainEngine,
  opts: TakeProposalReadOptions = {},
): Promise<TakeProposalRow[]> {
  const status = normalizeTakeProposalStatus(opts.status);
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const sourceIds = opts.sourceIds && opts.sourceIds.length > 0
    ? Array.from(new Set(opts.sourceIds))
    : null;
  const sourceId = sourceIds ? null : opts.sourceId ?? null;
  return await engine.executeRaw<TakeProposalRow>(
    `SELECT tp.id::int AS id, tp.source_id, tp.page_slug, tp.status, tp.claim_text, tp.kind, tp.holder,
            tp.weight, tp.domain, tp.model_id, tp.proposed_at, tp.acted_at, tp.acted_by,
            tp.promoted_row_num::int AS promoted_row_num,
            COALESCE(tc.n, 0)::int AS existing_take_count
       FROM take_proposals tp
       LEFT JOIN pages p ON p.source_id = tp.source_id AND p.slug = tp.page_slug
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n FROM takes t WHERE t.page_id = p.id
       ) tc ON true
      WHERE ($1 = 'all' OR tp.status = $1)
        AND ($3::text IS NULL OR tp.source_id = $3::text)
        AND ($4::text[] IS NULL OR tp.source_id = ANY($4::text[]))
      ORDER BY tp.proposed_at DESC, tp.id DESC
      LIMIT $2`,
    [status, limit, sourceId, sourceIds],
  );
}

async function lockProposal(
  engine: BrainEngine,
  id: number,
  sourceId?: string,
): Promise<TakeProposalRow> {
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT tp.id::int AS id, tp.source_id, tp.page_slug, tp.status, tp.claim_text, tp.kind, tp.holder,
            tp.weight, tp.domain, tp.model_id, tp.proposed_at, tp.acted_at, tp.acted_by,
            tp.promoted_row_num::int AS promoted_row_num,
            0::int AS existing_take_count
       FROM take_proposals tp
      WHERE tp.id = $1
        AND ($2::text IS NULL OR tp.source_id = $2::text)
      FOR UPDATE OF tp`,
    [id, sourceId ?? null],
  );
  const proposal = rows[0];
  if (!proposal) throw new TakeProposalError('not_found', scopedNotFoundMessage(sourceId));
  if (proposal.status !== 'pending') {
    throw new TakeProposalError('already_acted', `take proposal is already ${proposal.status}`);
  }
  return proposal;
}

/**
 * Promote a pending proposal into exactly one canonical takes row.
 *
 * The proposal and its page are locked in one transaction. The page lock
 * serializes row_num allocation for separate proposals targeting the same
 * page, while the provenance lookup prevents a proposal from producing a
 * second canonical row if an inconsistent legacy row already exists.
 */
export async function acceptTakeProposal(
  engine: BrainEngine,
  id: number,
  opts: TakeProposalActionOptions = {},
): Promise<TakeProposalRow> {
  validateProposalId(id);
  const actedBy = opts.actedBy ?? 'admin';
  return await engine.transaction(async tx => {
    const proposal = await lockProposal(tx, id, opts.sourceId);
    const pages = await tx.executeRaw<{ page_id: number }>(
      `SELECT p.id::int AS page_id
         FROM pages p
        WHERE p.source_id = $1 AND p.slug = $2
        FOR UPDATE OF p`,
      [proposal.source_id, proposal.page_slug],
    );
    const page = pages[0];
    if (!page) {
      throw new TakeProposalError(
        'source_page_not_found',
        `take proposal source page not found: ${proposal.source_id}/${proposal.page_slug}`,
      );
    }
    // Keep allocation in a separate statement after the page lock. On
    // Postgres READ COMMITTED, a statement that waited for FOR UPDATE keeps
    // its original snapshot for unrelated subqueries; reading MAX(row_num)
    // afterwards guarantees we see the canonical take committed by the
    // previous accepter of another proposal for this page.
    const stats = await tx.executeRaw<{ next_row_num: number; existing_take_count: number }>(
      `SELECT (COALESCE(MAX(row_num), 0) + 1)::int AS next_row_num,
              COUNT(*)::int AS existing_take_count
         FROM takes
        WHERE page_id = $1`,
      [page.page_id],
    );
    const nextRowNum = stats[0]?.next_row_num ?? 1;
    const existingTakeCount = stats[0]?.existing_take_count ?? 0;

    const canonicalSource = `take_proposal:${proposal.id}`;
    const existing = await tx.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes WHERE page_id = $1 AND source = $2`,
      [page.page_id, canonicalSource],
    );
    if ((existing[0]?.count ?? 0) > 0) {
      throw new TakeProposalError(
        'canonical_conflict',
        `take proposal ${proposal.id} already has a canonical take`,
      );
    }

    await tx.addTakesBatch([{
      page_id: page.page_id,
      row_num: nextRowNum,
      claim: proposal.claim_text,
      kind: proposal.kind,
      holder: proposal.holder,
      weight: proposal.weight,
      source: canonicalSource,
      active: true,
    }]);

    const inserted = await tx.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes WHERE page_id = $1 AND source = $2`,
      [page.page_id, canonicalSource],
    );
    if (inserted[0]?.count !== 1) {
      throw new TakeProposalError(
        'canonical_conflict',
        `take proposal ${proposal.id} did not create exactly one canonical take`,
      );
    }

    const updated = await tx.executeRaw<TakeProposalRow>(
      `UPDATE take_proposals
          SET status = 'accepted',
              acted_at = now(),
              acted_by = $2,
              promoted_row_num = $3
        WHERE id = $1 AND status = 'pending'
          AND ($5::text IS NULL OR source_id = $5::text)
        RETURNING id::int AS id, source_id, page_slug, status, claim_text, kind, holder, weight,
                  domain, model_id, proposed_at, acted_at, acted_by, promoted_row_num::int AS promoted_row_num,
                  $4::int AS existing_take_count`,
      [id, actedBy, nextRowNum, existingTakeCount + 1, opts.sourceId ?? null],
    );
    if (!updated[0]) {
      throw new TakeProposalError('already_acted', `take proposal ${proposal.id} changed while being accepted`);
    }
    return updated[0];
  });
}

/** Reject a pending proposal without creating a canonical takes row. */
export async function rejectTakeProposal(
  engine: BrainEngine,
  id: number,
  opts: TakeProposalActionOptions = {},
): Promise<TakeProposalRow> {
  validateProposalId(id);
  const actedBy = opts.actedBy ?? 'admin';
  return await engine.transaction(async tx => {
    const proposal = await lockProposal(tx, id, opts.sourceId);
    const updated = await tx.executeRaw<TakeProposalRow>(
      `UPDATE take_proposals
          SET status = 'rejected',
              acted_at = now(),
              acted_by = $2
        WHERE id = $1 AND status = 'pending'
          AND ($3::text IS NULL OR source_id = $3::text)
        RETURNING id::int AS id, source_id, page_slug, status, claim_text, kind, holder, weight,
                  domain, model_id, proposed_at, acted_at, acted_by, promoted_row_num::int AS promoted_row_num,
                  0::int AS existing_take_count`,
      [proposal.id, actedBy, opts.sourceId ?? null],
    );
    if (!updated[0]) {
      throw new TakeProposalError('already_acted', `take proposal ${proposal.id} changed while being rejected`);
    }
    return updated[0];
  });
}

// Keep the pre-existing Admin helper names/signatures stable while moving the
// implementation out of serve-http.ts for Operation reuse.
export type AdminTakeProposalRow = TakeProposalRow;

export function listAdminTakeProposals(
  engine: BrainEngine,
  opts: { status?: string; limit?: number } = {},
): Promise<AdminTakeProposalRow[]> {
  return listTakeProposals(engine, opts);
}

export function acceptAdminTakeProposal(
  engine: BrainEngine,
  id: number,
  actedBy = 'admin',
): Promise<AdminTakeProposalRow> {
  return acceptTakeProposal(engine, id, { actedBy });
}

export function rejectAdminTakeProposal(
  engine: BrainEngine,
  id: number,
  actedBy = 'admin',
): Promise<AdminTakeProposalRow> {
  return rejectTakeProposal(engine, id, { actedBy });
}
