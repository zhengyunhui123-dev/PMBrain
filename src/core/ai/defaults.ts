/**
 * Storage-only vector width used when a fresh database is created before an
 * embedding model is configured. This does not activate a provider or permit
 * vectorization; runtime embedding always requires an explicit model + dims.
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1280;
