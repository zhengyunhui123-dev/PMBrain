/**
 * A search time window answers "when was this about?", not "when was it imported?".
 * effective_date filled from updated_at/created_at uses source fallback or ingest
 * and must not enter the window.
 */
export function contentEventDateExpr(pageAlias = 'p'): string {
  return `(CASE WHEN ${pageAlias}.effective_date IS NOT NULL AND COALESCE(${pageAlias}.effective_date_source, '') NOT IN ('fallback', 'ingest') THEN ${pageAlias}.effective_date END)`;
}
