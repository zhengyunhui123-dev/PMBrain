import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { isLookupShapedQuery } from './query-intent.ts';
import { isPrivatePage } from './private-visibility.ts';

export const MAX_EXACT_LOOKUP_INJECT = 3;
export const EXACT_TITLE_STAMP = 1.25;

export function isSlugShapedQuery(query: string): boolean {
  const q = query.trim();
  return q.length > 0 && !/\s/.test(q) && q.includes('/') && !q.startsWith('/') && !q.endsWith('/');
}

export interface ExactLookupOpts {
  sourceId?: string;
  sourceIds?: string[];
  excludePrivate?: boolean;
  titleCandidates?: SearchResult[];
}

const MAX_SLUG_PROBE_SOURCES = 5;

export async function structuralExactLookup(
  engine: BrainEngine,
  query: string,
  opts: ExactLookupOpts = {},
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q || !isLookupShapedQuery(q)) return [];
  const hits: SearchResult[] = [];
  const seen = new Set<string>();
  const push = (result: SearchResult) => {
    const key = `${result.source_id ?? 'default'}::${result.slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(result);
  };

  if (isSlugShapedQuery(q)) {
    const scopes: Array<string | undefined> = opts.sourceIds?.length
      ? [...opts.sourceIds].sort().slice(0, MAX_SLUG_PROBE_SOURCES)
      : opts.sourceId != null ? [opts.sourceId] : [undefined];
    for (const sourceId of scopes) {
      try {
        const page = sourceId != null
          ? await engine.getPage(q, { sourceId })
          : await engine.getPage(q);
        if (!page || (opts.excludePrivate && isPrivatePage(page.frontmatter))) continue;
        push({
          page_id: page.id,
          slug: page.slug,
          title: page.title,
          type: page.type,
          source_id: page.source_id ?? sourceId ?? 'default',
          chunk_text: (page.compiled_truth ?? '').slice(0, 200),
          chunk_index: 0,
          chunk_id: 0,
          score: 0,
          alias_hit: true,
          exact_lookup: 'slug',
        } as SearchResult);
      } catch {
        // Fail open to the organic result set.
      }
    }
  }

  const queryNorm = normalizeAlias(q);
  if (queryNorm && opts.titleCandidates?.length) {
    for (const candidate of opts.titleCandidates) {
      if (!candidate.title || normalizeAlias(candidate.title) !== queryNorm) continue;
      push({
        ...candidate,
        title_match_boost: Math.max(candidate.title_match_boost ?? 1, EXACT_TITLE_STAMP),
        exact_lookup: candidate.exact_lookup ?? 'title',
      });
    }
  }
  return hits.slice(0, MAX_EXACT_LOOKUP_INJECT);
}

export async function applyExactLookupTier(
  engine: BrainEngine,
  results: SearchResult[],
  query: string,
  opts: ExactLookupOpts = {},
): Promise<SearchResult[]> {
  const hits = await structuralExactLookup(engine, query, opts).catch(() => []);
  if (hits.length === 0) return results;
  const out = [...results];
  let score = out.reduce((max, row) => Number.isFinite(row.score) ? Math.max(max, row.score) : max, 0) || 1;
  for (const hit of hits) {
    score += 1e-6;
    const index = out.findIndex((row) =>
      row.slug === hit.slug && (row.source_id ?? 'default') === (hit.source_id ?? 'default'));
    if (index >= 0) {
      out[index] = {
        ...out[index],
        score,
        exact_lookup: hit.exact_lookup,
        alias_hit: out[index].alias_hit || hit.alias_hit,
        title_match_boost: Math.max(out[index].title_match_boost ?? 1, hit.title_match_boost ?? 1),
      };
    } else {
      out.push({ ...hit, score, base_score: score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
