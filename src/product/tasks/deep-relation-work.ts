import type { BrainEngine } from '../../core/engine.ts';
import { mixRoundWork } from '../../core/pmbrain-adapters/deep-round-work.ts';
import { EXCLUDED_ENTITY_CAPTURE_PATH } from '../../core/pmbrain-adapters/entity-capture-request.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../core/link-extraction.ts';

export async function planDeepRelations(engine: BrainEngine, sourceId: string, prioritySlugs: string[]) {
  const rows = await engine.executeRaw<{ slug: string; fresh: boolean; total: number }>(`
    WITH pending AS (
      SELECT p.id, p.slug, p.slug=ANY($2::text[]) AS fresh
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND NOT s.archived AND p.slug !~* $3
        AND COALESCE(p.frontmatter->>'visibility','world')<>'private'
        AND COALESCE(p.frontmatter->>'private','false')<>'true'
        AND COALESCE(p.frontmatter->>'document_ocr_deferred','false')<>'true'
        AND (p.links_extracted_at IS NULL OR p.updated_at>p.links_extracted_at OR p.links_extracted_at<$4::timestamptz)
    ), ranked AS (
      SELECT slug, fresh, count(*) OVER (PARTITION BY fresh)::int AS total,
        row_number() OVER (PARTITION BY fresh ORDER BY id) AS position
      FROM pending
    )
    SELECT slug, fresh, total FROM ranked WHERE position <= 30 ORDER BY position`,
    [sourceId, prioritySlugs, EXCLUDED_ENTITY_CAPTURE_PATH.source, LINK_EXTRACTOR_VERSION_TS]);
  const fresh = rows.filter(row => row.fresh);
  const older = rows.filter(row => !row.fresh);
  return {
    slugs: mixRoundWork(fresh, older, 30).map(row => row.slug),
    pending: (fresh[0]?.total ?? 0) + (older[0]?.total ?? 0),
  };
}
