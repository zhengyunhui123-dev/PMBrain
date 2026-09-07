import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

export async function resolveAtomSlug(
  engine: BrainEngine, sourceId: string, title: string,
  kind: 'page' | 'transcript', locator: string, fallbackDate: string,
): Promise<string> {
  const existing = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND type = 'atom' AND title = $2
      AND deleted_at IS NULL
      AND CASE WHEN $3 = 'page' THEN frontmatter->>'source_slug' ELSE frontmatter->>'source_path' END = $4
      ORDER BY id LIMIT 2`,
    [sourceId, title, kind, locator],
  );
  if (existing.length > 1) throw new Error('ambiguous historical atom source binding');
  if (existing.length === 1) return existing[0].slug;
  const date = locator.match(/(?:^|[^0-9])(\d{4}-\d{2}-\d{2})(?=[^0-9]|$)/)?.[1] ?? fallbackDate;
  const hash = createHash('sha256').update(JSON.stringify([sourceId, kind, locator, title.normalize('NFKC')])).digest('hex').slice(0, 16);
  const stem = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'atom';
  return `atoms/${date}/${stem}-${hash}`;
}
