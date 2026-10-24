import type { BrainEngine } from '../engine.ts';

export const FACT_WITHDRAWN_MESSAGE = 'fact_withdrawn: this exact claim was explicitly forgotten in this source and visibility.';
export const FACT_WITHDRAWN_SUGGESTION = 'A forgotten claim stays withdrawn, and remembering the same text again is refused; '
  + 'a claim forgotten without an entity is withdrawn for every entity. If it is still true, remember it in new words. '
  + 'To link a fact saved without an entity, do not forget it: remember it with entity and replaces set to its fact id.';

export class FactWithdrawnError extends Error {
  readonly rule = 'fact_withdrawn';
  constructor(message = FACT_WITHDRAWN_MESSAGE, readonly suggestion = FACT_WITHDRAWN_SUGGESTION) {
    super(message);
    this.name = 'FactWithdrawnError';
  }
}

export class MemoryRuleError extends Error {
  constructor(readonly rule: string, message: string, readonly suggestion: string) {
    super(message);
    this.name = 'MemoryRuleError';
  }
}

export async function assertFactWritable(
  engine: BrainEngine,
  sourceId: string,
  visibility: string,
  fact: string,
  entitySlug: string | null,
): Promise<void> {
  const rows = await engine.executeRaw(
    `SELECT 1 FROM fact_withdrawals
      WHERE source_id=$1 AND visibility=$2
        AND fact_hash IN (gbrain_fact_fingerprint($3), gbrain_fact_fingerprint_v1($3))
        AND (subject = '*' OR subject = $4::text)
      LIMIT 1`,
    [sourceId, visibility, fact, entitySlug],
  );
  if (rows.length) throw new FactWithdrawnError();
}

export async function recordFactWithdrawal(engine: BrainEngine, factId: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash)
      SELECT source_id, visibility, COALESCE(entity_slug, '*'), gbrain_fact_fingerprint(fact)
      FROM facts WHERE id=$1
      ON CONFLICT DO NOTHING`,
    [factId],
  );
  await engine.executeRaw(
    `UPDATE facts AS sibling
        SET expired_at = now(),
            valid_until = LEAST(COALESCE(sibling.valid_until, now()), now())
       FROM facts AS target
      WHERE target.id = $1
        AND sibling.source_id = target.source_id
        AND sibling.visibility = target.visibility
        AND sibling.expired_at IS NULL
        AND gbrain_fact_fingerprint(sibling.fact) = gbrain_fact_fingerprint(target.fact)
        AND (COALESCE(target.entity_slug, '*') = '*' OR sibling.entity_slug = target.entity_slug)`,
    [factId],
  );
}

interface ReplacementTarget {
  id: number;
  fact: string;
  visibility: string;
  entity_slug: string | null;
  expired_at: string | null;
  valid_until: string | null;
  superseded_by: number | null;
  context: string | null;
  source_markdown_slug: string | null;
  withdrawn: boolean;
}

export async function decideCallerReplacement(
  engine: BrainEngine,
  sourceId: string,
  targetId: number,
  input: { fact: string; visibility: string; entitySlug: string | null; remote?: boolean },
): Promise<{ status: 'superseded' | 'duplicate'; id: number }> {
  const notFound = () => new MemoryRuleError(
    'not_found',
    `No fact with id "${targetId}" to replace.`,
    'Pass the fact_id of an active fact from recall about the same entity, or omit replaces to save a new fact.',
  );
  const [target] = await engine.executeRaw<ReplacementTarget>(
    `SELECT f.id, f.fact, f.visibility, f.entity_slug, f.expired_at::text AS expired_at, f.valid_until::text AS valid_until,
            f.superseded_by, f.context, f.source_markdown_slug,
            EXISTS (
              SELECT 1 FROM fact_withdrawals w
               WHERE w.source_id = f.source_id AND w.visibility = f.visibility
                 AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
                 AND (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*'))
            ) AS withdrawn
       FROM facts f WHERE f.id = $1 AND f.source_id = $2`,
    [targetId, sourceId],
  );
  if (!target || (input.remote && target.visibility !== 'world') || target.visibility !== input.visibility) throw notFound();
  const forgotten = (target.context ?? '').includes('forgotten:') && !(target.context ?? '').includes('superseded by fact #');
  if (target.withdrawn || forgotten) {
    throw new MemoryRuleError(
      'target_withdrawn',
      `target_withdrawn: fact #${targetId} was forgotten, so it cannot be replaced.`,
      'Remember the new claim without replaces; the forgotten claim stays withdrawn.',
    );
  }
  const expired = target.expired_at != null || (target.valid_until != null && new Date(target.valid_until).getTime() <= Date.now());
  if (expired) {
    if (target.superseded_by != null || (target.context ?? '').includes('superseded by fact #')) {
      throw new MemoryRuleError(
        'target_superseded',
        `target_superseded: fact #${targetId} was already replaced by fact #${target.superseded_by}.`,
        `Recall the entity to check the current fact, then pass replaces: "${target.superseded_by}" if the new claim replaces that one.`,
      );
    }
    throw new MemoryRuleError(
      'target_expired',
      `target_expired: fact #${targetId} is no longer active.`,
      'Remember the new claim without replaces.',
    );
  }
  if (target.entity_slug != null && target.entity_slug !== input.entitySlug) {
    throw new MemoryRuleError(
      'replaces_entity_mismatch',
      `replaces_entity_mismatch: fact #${targetId} is about ${target.entity_slug}, not ${input.entitySlug ?? 'no entity'}.`,
      'Pass the same entity as the fact being replaced, or forget the old fact and remember the new one separately.',
    );
  }
  if (target.source_markdown_slug && target.source_markdown_slug !== input.entitySlug) {
    throw new MemoryRuleError(
      'replaces_cross_page',
      `replaces_cross_page: fact #${targetId} lives on page ${target.source_markdown_slug}.`,
      'Forget the old fact, then remember the new one.',
    );
  }
  const [exact] = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM facts
      WHERE source_id=$1 AND visibility=$2 AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND gbrain_fact_fingerprint(fact) = gbrain_fact_fingerprint($3)
        AND entity_slug IS NOT DISTINCT FROM $4
      ORDER BY id LIMIT 1`,
    [sourceId, input.visibility, input.fact, input.entitySlug],
  );
  if (exact && Number(exact.id) === Number(target.id)) return { status: 'duplicate', id: Number(target.id) };
  if (exact) {
    throw new MemoryRuleError(
      'replaces_duplicate',
      `replaces_duplicate: an active fact (#${exact.id}) already states this claim.`,
      `Forget fact #${targetId} if it is no longer true; the existing fact #${exact.id} already says the new claim.`,
    );
  }
  return { status: 'superseded', id: Number(target.id) };
}
