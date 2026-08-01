export type PgliteDataClass = 'protected' | 'derived' | 'runtime';

/**
 * PMBrain is not a file-repo-only brain: unknown data is protected by default.
 * Only artifacts on this allow-list may be rebuilt without restoring a full
 * verified database backup.
 */
const DERIVED_ARTIFACTS = new Set([
  'content_chunks.rows',
  'content_chunks.embedding',
  'content_chunks.embedded_at',
  'content_chunks.model',
  'content_chunks.search_vector',
  'facts.embedding',
  'facts.embedded_at',
  'query_cache.rows',
  'search.hnsw_indexes',
  'search.fts_indexes',
]);

const RUNTIME_ARTIFACTS = new Set([
  '.gbrain-lock',
  'temporary.restore-verification-copy',
]);

export const PGLITE_DATA_PROTECTION_POLICY = Object.freeze({
  version: 1,
  default_class: 'protected' as const,
  protected_examples: Object.freeze([
    'pages.rows',
    'page_versions.rows',
    'sources.rows',
    'tags.rows',
    'links.user_rows',
    'timeline_entries.rows',
    'takes.rows',
    'facts.rows',
    'access_tokens.rows',
    'oauth_clients.rows',
  ]),
  derived_artifacts: Object.freeze([...DERIVED_ARTIFACTS]),
  runtime_artifacts: Object.freeze([...RUNTIME_ARTIFACTS]),
  rule: 'Only explicitly allow-listed derived artifacts may be rebuilt; every unknown artifact is protected.',
});

export function classifyPgliteDataArtifact(artifact: string): PgliteDataClass {
  if (DERIVED_ARTIFACTS.has(artifact)) return 'derived';
  if (RUNTIME_ARTIFACTS.has(artifact)) return 'runtime';
  return 'protected';
}
