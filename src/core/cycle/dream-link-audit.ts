import type { BrainEngine } from '../engine.ts';
import { stripCodeBlocks } from '../link-extraction.ts';

const WIKILINK_TARGET = /\[\[([^|\]#\n]+)(?:#[^|\]]*)?(?:\|[^\]]*)?\]\]/g;

export function wikilinkTargets(body: string): string[] {
  const found: string[] = [];
  for (const match of stripCodeBlocks(body).matchAll(WIKILINK_TARGET)) {
    let target = match[1]!.trim().replace(/\\/g, '/');
    if (!target || target.includes('://') || /^https?:/i.test(target)) continue;
    target = target.replace(/\.md$/i, '');
    if (target) found.push(target);
  }
  return [...new Set(found)];
}

export function danglingWikilinks(body: string, live: ReadonlySet<string>): string[] {
  return wikilinkTargets(body).filter(target => {
    const colon = target.indexOf(':');
    const bare = colon > 0 && !target.slice(0, colon).includes('/') ? target.slice(colon + 1) : target;
    return !live.has(target) && !live.has(bare);
  });
}

function referenceOf(reference: string, fallbackSourceId: string): { sourceId: string; slug: string } | null {
  const trimmed = reference.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !trimmed.slice(0, colon).includes('/')) {
    const slug = trimmed.slice(colon + 1).trim();
    return slug ? { sourceId: trimmed.slice(0, colon), slug } : null;
  }
  return trimmed ? { sourceId: fallbackSourceId, slug: trimmed } : null;
}

export async function auditDreamLinks(
  engine: BrainEngine,
  fallbackSourceId: string,
  references: string[],
): Promise<{ unresolved: Array<{ slug: string; targets: string[] }>; unlinked: string[] }> {
  const pages = references.map(reference => referenceOf(reference, fallbackSourceId)).filter((page): page is { sourceId: string; slug: string } => !!page);
  if (!pages.length) return { unresolved: [], unlinked: [] };
  const slugs = [...new Set(pages.map(page => page.slug))];
  const rows = await engine.executeRaw<{ slug: string; source_id: string; compiled_truth: string | null }>(
    `SELECT slug, source_id, compiled_truth FROM pages WHERE deleted_at IS NULL AND slug = ANY($1::text[])`,
    [slugs],
  );
  const targets = [...new Set(rows.flatMap(row => wikilinkTargets(row.compiled_truth ?? '')))];
  const bareTargets = [...new Set(targets.map(target => referenceOf(target, fallbackSourceId)?.slug).filter((slug): slug is string => !!slug))];
  const found = bareTargets.length
    ? await engine.executeRaw<{ slug: string; source_id: string }>(
      `SELECT slug, source_id FROM pages WHERE deleted_at IS NULL AND slug = ANY($1::text[]) AND source_id = ANY($2::text[])`,
      [bareTargets, [...new Set([fallbackSourceId, 'default', ...targets.flatMap(target => {
        const parsed = referenceOf(target, fallbackSourceId);
        return parsed ? [parsed.sourceId] : [];
      })])]],
    )
    : [];
  const live = new Set(found.flatMap(row => [row.slug, `${row.source_id}:${row.slug}`]));
  const unresolved = rows.flatMap(row => {
    const missing = danglingWikilinks(row.compiled_truth ?? '', live);
    return missing.length ? [{ slug: `${row.source_id}:${row.slug}`, targets: missing }] : [];
  });
  const inbound = await engine.executeRaw<{ slug: string; source_id: string }>(
    `SELECT t.slug, t.source_id FROM links l JOIN pages t ON t.id = l.to_page_id
      WHERE t.deleted_at IS NULL AND t.slug = ANY($1::text[])`,
    [slugs],
  );
  const linked = new Set(inbound.map(row => `${row.source_id}:${row.slug}`));
  const unlinked = pages.filter(page => !linked.has(`${page.sourceId}:${page.slug}`)).map(page => `${page.sourceId}:${page.slug}`);
  return { unresolved, unlinked };
}
