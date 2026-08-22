import type { BrainEngine } from '../engine.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

export function privatePagesFilterFragment(pageAlias: string): string {
  return `COALESCE(${pageAlias}.frontmatter->>'visibility', 'world') <> 'private'`;
}

export function isPrivatePage(frontmatter: unknown): boolean {
  return typeof frontmatter === 'object'
    && frontmatter !== null
    && (frontmatter as Record<string, unknown>).visibility === 'private';
}

export async function findPrivateOnlySlugs(
  engine: BrainEngine,
  slugs: string[],
  scope: { sourceId?: string; sourceIds?: string[] } = {},
  opts: { includeDeleted?: boolean } = {},
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  let scopeClause = '';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    scopeClause = `AND p.source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${opts.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_and(NOT (${privatePagesFilterFragment('p')}))`,
    params,
  );
  return new Set(rows.map(row => row.slug));
}

export async function slugHiddenFromCaller(
  engine: BrainEngine,
  remote: boolean | undefined,
  slug: string,
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<boolean> {
  if (!(await resolveExcludePrivatePages(engine, remote))) return false;
  return (await findPrivateOnlySlugs(engine, [slug], scope, { includeDeleted: true })).has(slug);
}

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
}

export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return false;
  if (process.env.PMBRAIN_REMOTE_PRIVATE_PAGES === '1' || process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false;
  const hit = cache.get(engine);
  let expose: boolean;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    expose = hit.expose;
  } else {
    try {
      const value = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
      expose = value === 'visible' || value === 'true' || value === '1';
    } catch {
      expose = false;
    }
    cache.set(engine, { at: Date.now(), expose });
  }
  return !expose;
}
