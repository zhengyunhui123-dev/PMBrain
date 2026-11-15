import type { SearchResult } from '../types.ts';

export const CONCLUSION_PENDING = 'pending_verification';
export const CONCLUSION_PENDING_LABEL = '待重新核验';
export const CONCLUSION_CURRENT = 'current';
export const CONCLUSION_CURRENT_LABEL = '仍有效';

export interface ConclusionReview {
  review_status: string;
  review_label: string;
}

export function conclusionReviewFromFrontmatter(
  type: string | undefined,
  frontmatter: Record<string, unknown> | null | undefined,
): ConclusionReview | undefined {
  const fields = frontmatter ?? {};
  const status = typeof fields.pmbrain_review_status === 'string' ? fields.pmbrain_review_status : '';
  const label = typeof fields.pmbrain_review_label === 'string' ? fields.pmbrain_review_label : '';
  if (status === CONCLUSION_PENDING) {
    return { review_status: CONCLUSION_PENDING, review_label: label || CONCLUSION_PENDING_LABEL };
  }
  if (status === CONCLUSION_CURRENT || (type === 'concept' && fields.pmbrain_concept_complete !== false && status === '')) {
    return { review_status: CONCLUSION_CURRENT, review_label: label || CONCLUSION_CURRENT_LABEL };
  }
  return undefined;
}

type ReviewQuery = {
  executeRaw?<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

export async function stampConclusionReview(
  engine: ReviewQuery,
  results: SearchResult[],
): Promise<void> {
  const ids = [...new Set(results.map(result => Number(result.page_id)).filter(id => Number.isInteger(id) && id > 0))];
  if (!ids.length || typeof engine.executeRaw !== 'function') return;
  try {
    const rows = await engine.executeRaw<{
      id: number | string;
      type: string | null;
      review_status: string | null;
      review_label: string | null;
      complete: string | null;
    }>(
      `SELECT id, type,
              frontmatter->>'pmbrain_review_status' AS review_status,
              frontmatter->>'pmbrain_review_label' AS review_label,
              frontmatter->>'pmbrain_concept_complete' AS complete
         FROM pages
        WHERE id = ANY($1::int[])`,
      [ids],
    );
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    for (const result of results) {
      const row = byId.get(Number(result.page_id));
      if (!row) continue;
      const complete = row.complete === 'false' ? false : row.complete === 'true' ? true : undefined;
      const review = conclusionReviewFromFrontmatter(row.type ?? result.type, {
        pmbrain_review_status: row.review_status,
        pmbrain_review_label: row.review_label,
        ...(complete === undefined ? {} : { pmbrain_concept_complete: complete }),
      });
      if (!review) continue;
      result.review_status = review.review_status;
      result.review_label = review.review_label;
    }
  } catch {
    // Review status is additive. A lookup failure must not hide the search result.
  }
}
