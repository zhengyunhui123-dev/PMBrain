export const PGLITE_GIN_INDEX_NAMES = [
  'idx_pages_search',
  'idx_pages_trgm',
  'idx_pages_compiled_truth_trgm',
  'idx_pages_slug_trgm',
  'idx_pages_frontmatter',
  'idx_chunks_text_trgm',
] as const;

export function isGinCorruptionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /right sibling of GIN page is of different type|GIN page is of different type/i.test(msg);
}

export async function repairPgliteGinIndexes(
  engine: { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown> },
): Promise<number> {
  let repaired = 0;
  for (const name of PGLITE_GIN_INDEX_NAMES) {
    try {
      await engine.executeRaw(`REINDEX INDEX ${name}`);
      repaired++;
    } catch {
      /* older schemas may lack a given index */
    }
  }
  return repaired;
}
