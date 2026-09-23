import type { BrainEngine } from '../engine.ts';

/** Source-local high-confidence slug only — never persist fallback_slugify. */
export async function resolveLoopCounterpartySlug(
  engine: BrainEngine,
  sourceId: string,
  name: string | null | undefined,
): Promise<string | null> {
  if (!name || name.trim() === '') return null;
  try {
    const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
    const resolved = await resolveEntitySlugWithSource(engine, sourceId, name);
    if (resolved && resolved.source !== 'fallback_slugify') return resolved.slug;
  } catch {
    /* resolution is best-effort */
  }
  return null;
}

export function senderMuteValue(sourceId: string, entitySlug: string): string {
  return `slug:${sourceId}:${entitySlug}`.toLowerCase();
}
