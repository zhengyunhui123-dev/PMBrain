export function importOutcome(result: unknown) {
  if (!result || typeof result !== 'object') return null;
  const data = result as Record<string, unknown>;
  if (typeof data.imported !== 'number' || typeof data.skipped !== 'number' || typeof data.errors !== 'number') return null;
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const partial = typeof data.partialFiles === 'number' ? count(data.partialFiles) : Math.max(0, count(data.errors) - count(data.skipped));
  const imported = Math.max(0, count(data.imported) - partial);
  const failed = Math.max(0, count(data.errors) - partial);
  const unchanged = typeof data.unchanged === 'number' ? count(data.unchanged) : Math.max(0, count(data.skipped) - failed);
  const processed = typeof data.processed === 'number' ? count(data.processed) : count(data.imported) + count(data.skipped);
  const total = typeof data.total === 'number' ? count(data.total) : null;
  const outcome = failed + partial > 0 ? imported + unchanged + partial > 0 ? 'partial' : 'failed' : 'completed';
  return { imported, unchanged, failed, partial, processed, total, outcome } as const;
}
