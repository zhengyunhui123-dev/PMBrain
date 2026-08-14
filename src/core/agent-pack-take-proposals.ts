import type { BrainEngine, TakeKind } from './engine.ts';
import { OperationError } from './operation-error.ts';
import { readCanonicalPageFile } from './canonical-page-file.ts';
import {
  EMPTY_EXTRACTION_TOMBSTONE_TEXT,
  legacyTakeProposalContentHash,
  takeProposalContentHash,
} from './take-proposal-hash.ts';
import { addCanonicalTake } from './canonical-takes.ts';
import { withPageLock } from './page-lock.ts';

export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  content_hash: string;
  prompt_version: string;
  proposed_at: string;
  status: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  dedup_against_fence_rows: unknown;
  model_id: string;
  reviewed_at: string | null;
  review_note: string | null;
  accepted_take_id: number | null;
  accepted_claim: string | null;
  accepted_kind: string | null;
  accepted_holder: string | null;
  accepted_weight: number | null;
  accepted_domain: string | null;
  promoted_row_num: number | null;
}

export interface ProposalScope {
  sourceId?: string;
  sourceIds?: string[];
}

export interface ListTakeProposalOptions extends ProposalScope {
  status?: string;
  limit?: number;
  pageSlug?: string;
  kind?: string;
  takesHoldersAllowList?: string[];
}

export interface AcceptTakeProposalInput {
  proposalId: number;
  sourceId: string;
  editedClaim?: string;
  editedKind?: string;
  editedHolder?: string;
  editedWeight?: number;
  editedDomain?: string;
  reviewNote?: string;
  actedBy?: string;
  takesHoldersAllowList?: string[];
}

function assertProposalVisible(proposal: TakeProposalRow, takesHoldersAllowList?: string[]): void {
  const visibleHolder = proposal.status === 'accepted'
    ? proposal.accepted_holder ?? proposal.holder
    : proposal.holder;
  if (takesHoldersAllowList && !takesHoldersAllowList.includes(visibleHolder)) {
    throw new OperationError('proposal_not_found', `Take proposal not found: ${proposal.id}`);
  }
}

function normalizeRow(row: TakeProposalRow): TakeProposalRow {
  return {
    ...row,
    id: Number(row.id),
    weight: Number(row.weight),
    accepted_take_id: row.accepted_take_id == null ? null : Number(row.accepted_take_id),
    promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
    accepted_weight: row.accepted_weight == null ? null : Number(row.accepted_weight),
  };
}

async function loadProposal(
  engine: BrainEngine,
  proposalId: number,
  scope: ProposalScope,
): Promise<TakeProposalRow | null> {
  const params: unknown[] = [proposalId];
  let scopeSql = '';
  if (scope.sourceIds) {
    if (scope.sourceIds.length === 0) return null;
    params.push(scope.sourceIds);
    scopeSql = ` AND source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeSql = ` AND source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT * FROM take_proposals WHERE id = $1${scopeSql} LIMIT 1`,
    params,
  );
  return rows[0] ? normalizeRow(rows[0]) : null;
}

async function staleState(engine: BrainEngine, proposal: TakeProposalRow) {
  const sourceFile = await readCanonicalPageFile(engine, proposal.source_id, proposal.page_slug);
  const page = await engine.getPage(proposal.page_slug, { sourceId: proposal.source_id });
  if (sourceFile) {
    const currentHash = takeProposalContentHash(sourceFile.parsed.compiled_truth);
    const legacyHash = legacyTakeProposalContentHash(sourceFile.parsed.compiled_truth);
    const dbCurrentHash = page ? takeProposalContentHash(page.compiled_truth ?? '') : null;
    const dbLegacyHash = page ? legacyTakeProposalContentHash(page.compiled_truth ?? '') : null;
    const sameSourceText = dbCurrentHash === currentHash;
    const matchesDisk = currentHash === proposal.content_hash || legacyHash === proposal.content_hash;
    const matchesLegacyDb = sameSourceText && dbLegacyHash === proposal.content_hash;
    return {
      stale: !matchesDisk && !matchesLegacyDb,
      currentHash,
      page,
      sourceFile,
    };
  }
  const currentHash = page ? takeProposalContentHash(page.compiled_truth ?? '') : null;
  const legacyHash = page ? legacyTakeProposalContentHash(page.compiled_truth ?? '') : null;
  return {
    stale: currentHash === null || (currentHash !== proposal.content_hash && legacyHash !== proposal.content_hash),
    currentHash,
    page,
    sourceFile: null,
  };
}

function publicProposal(row: TakeProposalRow, stale: boolean | null) {
  return {
    proposal_id: row.id,
    claim_text: row.claim_text,
    kind: row.kind,
    holder: row.holder,
    weight: row.weight,
    domain: row.domain,
    page_slug: row.page_slug,
    source_id: row.source_id,
    created_at: row.proposed_at,
    prompt_version: row.prompt_version,
    status: row.status,
    stale,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
    accepted_take_id: row.accepted_take_id,
  };
}

export async function listTakeProposals(engine: BrainEngine, opts: ListTakeProposalOptions = {}) {
  const params: unknown[] = [opts.status ?? 'pending'];
  const where = [
    'status = $1',
    `claim_text <> '${EMPTY_EXTRACTION_TOMBSTONE_TEXT.replace(/'/g, "''")}'`,
  ];
  if (opts.pageSlug) {
    params.push(opts.pageSlug);
    where.push(`page_slug = $${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.sourceIds) {
    if (opts.sourceIds.length === 0) return { proposals: [], count: 0 };
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  } else if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  if (opts.takesHoldersAllowList) {
    params.push(opts.takesHoldersAllowList);
    where.push(`(
      CASE WHEN status = 'accepted' THEN COALESCE(accepted_holder, holder) ELSE holder END
    ) = ANY($${params.length}::text[])`);
  }
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 10)));
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT * FROM take_proposals
      WHERE ${where.join(' AND ')}
      ORDER BY proposed_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  const proposals = await Promise.all(rows.map(async raw => {
    const row = normalizeRow(raw);
    const state = await staleState(engine, row);
    return publicProposal(row, state.stale);
  }));
  return { proposals, count: proposals.length };
}

export async function getTakeProposal(
  engine: BrainEngine,
  proposalId: number,
  scope: ProposalScope,
  takesHoldersAllowList?: string[],
) {
  const proposal = await loadProposal(engine, proposalId, scope);
  if (!proposal || proposal.claim_text === EMPTY_EXTRACTION_TOMBSTONE_TEXT) {
    throw new OperationError('proposal_not_found', `Take proposal not found: ${proposalId}`);
  }
  assertProposalVisible(proposal, takesHoldersAllowList);
  const state = await staleState(engine, proposal);
  const canonical = state.page?.id
    ? await engine.listTakes({
        page_id: state.page.id,
        active: true,
        limit: 200,
        takesHoldersAllowList,
      })
    : [];
  const normalizedClaim = proposal.claim_text.trim().toLocaleLowerCase();
  const possibleDuplicates = canonical.filter((take) => {
    const existing = take.claim.trim().toLocaleLowerCase();
    return existing === normalizedClaim || existing.includes(normalizedClaim) || normalizedClaim.includes(existing);
  });
  const sourceBody = state.sourceFile?.parsed.compiled_truth ?? state.page?.compiled_truth ?? null;
  return {
    proposal: {
      ...publicProposal(proposal, state.stale),
      content_hash: proposal.content_hash,
      model_id: proposal.model_id,
      dedup_against_fence_rows: proposal.dedup_against_fence_rows,
      accepted_claim: proposal.accepted_claim,
      accepted_kind: proposal.accepted_kind,
      accepted_holder: proposal.accepted_holder,
      accepted_weight: proposal.accepted_weight,
      accepted_domain: proposal.accepted_domain,
    },
    source_page: state.page ? {
      id: state.page.id,
      source_id: state.page.source_id,
      slug: state.page.slug,
      title: state.page.title,
      type: state.page.type,
      compiled_truth: sourceBody,
      updated_at: state.page.updated_at,
      content_hash: state.currentHash,
      markdown_path: state.sourceFile?.path ?? null,
      source_available: state.sourceFile !== null,
    } : null,
    source_context: sourceBody ? sourceBody.slice(0, 8_000) : null,
    generated_content_hash: proposal.content_hash,
    current_content_hash: state.currentHash,
    stale: state.stale,
    canonical_takes: canonical,
    possible_duplicates: possibleDuplicates,
    review_status: proposal.status,
  };
}

function validateEdited(input: AcceptTakeProposalInput, proposal: TakeProposalRow) {
  const claim = input.editedClaim?.trim() || proposal.claim_text;
  const kind = input.editedKind?.trim() || proposal.kind;
  const holder = input.editedHolder?.trim() || proposal.holder;
  const weight = input.editedWeight ?? proposal.weight;
  const domain = input.editedDomain?.trim() || proposal.domain || undefined;
  if (!claim || claim.length > 2_000) {
    throw new OperationError('invalid_params', 'edited_claim must contain 1 to 2000 characters');
  }
  if (!kind || kind.length > 64) throw new OperationError('invalid_params', 'edited_kind is invalid');
  if (!holder || holder.length > 255) throw new OperationError('invalid_params', 'edited_holder is invalid');
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new OperationError('invalid_params', 'edited_weight must be between 0 and 1');
  }
  return { claim, kind: kind as TakeKind, holder, weight, domain };
}

async function acceptedResult(engine: BrainEngine, proposal: TakeProposalRow) {
  if (!proposal.accepted_take_id) {
    throw new OperationError('invalid_state', `Proposal ${proposal.id} is accepted but has no canonical take link`);
  }
  const rows = await engine.executeRaw<{
    id: number; row_num: number; claim: string; kind: string; holder: string; weight: number;
  }>('SELECT id, row_num, claim, kind, holder, weight FROM takes WHERE id = $1', [proposal.accepted_take_id]);
  const take = rows[0];
  if (!take) throw new OperationError('invalid_state', `Accepted take ${proposal.accepted_take_id} no longer exists`);
  return {
    status: 'accepted',
    proposal_id: proposal.id,
    take_id: Number(take.id),
    row_num: Number(take.row_num),
    claim: take.claim,
    kind: take.kind,
    holder: take.holder,
    weight: Number(take.weight),
    idempotent: true,
  };
}

export async function acceptTakeProposal(engine: BrainEngine, input: AcceptTakeProposalInput) {
  const initial = await loadProposal(engine, input.proposalId, { sourceId: input.sourceId });
  if (!initial || initial.claim_text === EMPTY_EXTRACTION_TOMBSTONE_TEXT) {
    throw new OperationError('proposal_not_found', `Take proposal not found: ${input.proposalId}`);
  }
  assertProposalVisible(initial, input.takesHoldersAllowList);
  if (initial.status === 'accepted') return acceptedResult(engine, initial);
  if (initial.status !== 'pending') {
    throw new OperationError('invalid_state', `Proposal ${initial.id} is ${initial.status} and cannot be accepted`);
  }

  return withPageLock(`${initial.source_id}:${initial.page_slug}`, async () => {
    const proposal = await loadProposal(engine, input.proposalId, { sourceId: input.sourceId });
    if (!proposal) throw new OperationError('proposal_not_found', `Take proposal not found: ${input.proposalId}`);
    assertProposalVisible(proposal, input.takesHoldersAllowList);
    if (proposal.status === 'accepted') return acceptedResult(engine, proposal);
    if (proposal.status !== 'pending') {
      throw new OperationError('invalid_state', `Proposal ${proposal.id} is ${proposal.status} and cannot be accepted`);
    }
    const state = await staleState(engine, proposal);
    if (!state.sourceFile || state.stale) {
      throw new OperationError(
        'stale_proposal',
        '来源页面在该观点生成以后发生变化，应先重新查看依据。',
        `Call get_take_proposal with proposal_id=${proposal.id} before deciding again.`,
      );
    }
    const final = validateEdited(input, proposal);
    if (input.takesHoldersAllowList && !input.takesHoldersAllowList.includes(final.holder)) {
      throw new OperationError('permission_denied', `Holder "${final.holder}" is outside this credential's takes_holders scope.`);
    }
    const result = await addCanonicalTake(engine, {
      pageSlug: proposal.page_slug,
      sourceId: proposal.source_id,
      claim: final.claim,
      kind: final.kind,
      holder: final.holder,
      weight: final.weight,
      domain: final.domain,
      source: `take proposal #${proposal.id}`,
    }, {
      lockHeld: true,
      afterPersist: async ({ tx, takeId, rowNum }) => {
        const updated = await tx.executeRaw<{ id: number }>(
          `UPDATE take_proposals
              SET status = 'accepted', acted_at = now(), reviewed_at = now(),
                  acted_by = $2, review_note = $3, accepted_take_id = $4,
                  promoted_row_num = $5, accepted_claim = $6, accepted_kind = $7,
                  accepted_holder = $8, accepted_weight = $9, accepted_domain = $10
            WHERE id = $1 AND source_id = $11 AND status = 'pending'
            RETURNING id`,
          [
            proposal.id,
            input.actedBy ?? 'user-approved-agent',
            input.reviewNote ?? null,
            takeId,
            rowNum,
            final.claim,
            final.kind,
            final.holder,
            final.weight,
            final.domain ?? null,
            proposal.source_id,
          ],
        );
        if (updated.length !== 1) throw new OperationError('conflict', `Proposal ${proposal.id} changed during acceptance`);
      },
    });
    return {
      status: 'accepted',
      proposal_id: proposal.id,
      take_id: result.takeId,
      row_num: result.rowNum,
      claim: final.claim,
      kind: final.kind,
      holder: final.holder,
      weight: final.weight,
      domain: final.domain ?? null,
      created: result.created,
      idempotent: false,
    };
  });
}

export async function rejectTakeProposal(
  engine: BrainEngine,
  input: {
    proposalId: number;
    sourceId: string;
    reason?: string;
    actedBy?: string;
    takesHoldersAllowList?: string[];
  },
) {
  const note = input.reason?.trim() || null;
  const rows = await engine.executeRaw<{ reviewed_at: string }>(
    `UPDATE take_proposals
        SET status = 'rejected', acted_at = now(), reviewed_at = now(),
            acted_by = $2, review_note = $3
      WHERE id = $1 AND source_id = $4 AND status = 'pending'
        AND claim_text <> $5
        AND ($6::text[] IS NULL OR holder = ANY($6::text[]))
      RETURNING reviewed_at`,
    [
      input.proposalId,
      input.actedBy ?? 'user-approved-agent',
      note,
      input.sourceId,
      EMPTY_EXTRACTION_TOMBSTONE_TEXT,
      input.takesHoldersAllowList ?? null,
    ],
  );
  // postgres.js releases a single pooled connection on the next macrotask.
  // Yield here so an immediate library caller can safely issue its next op.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (rows.length === 1) {
    return {
      status: 'rejected',
      proposal_id: input.proposalId,
      reviewed_at: rows[0]!.reviewed_at,
      review_note: note,
      idempotent: false,
    };
  }

  const proposal = await loadProposal(engine, input.proposalId, { sourceId: input.sourceId });
  if (!proposal || proposal.claim_text === EMPTY_EXTRACTION_TOMBSTONE_TEXT) {
    throw new OperationError('proposal_not_found', `Take proposal not found: ${input.proposalId}`);
  }
  assertProposalVisible(proposal, input.takesHoldersAllowList);
  if (proposal.status === 'rejected') {
    return {
      status: 'rejected',
      proposal_id: proposal.id,
      reviewed_at: proposal.reviewed_at,
      review_note: proposal.review_note,
      idempotent: true,
    };
  }
  throw new OperationError('invalid_state', `Proposal ${proposal.id} is ${proposal.status} and cannot be rejected`);
}
