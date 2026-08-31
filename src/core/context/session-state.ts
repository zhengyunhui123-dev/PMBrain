/**
 * Per-session Context Engine state. All reads and writes are Source/client
 * scoped and fail open because context restoration must never block a turn.
 */
import type { BrainEngine } from '../engine.ts';

export const LOCAL_CONTEXT_CLIENT = 'local';
const ID_MAX = 200;
const MANIFEST_CAP = 20;

export interface CheckpointLink {
  slug: string;
  title: string;
  at: string;
  segment: string;
}

export interface SessionContextState {
  standing_entities: string[];
  surfaced_slugs: string[];
  checkpoint_manifest: CheckpointLink[];
  last_wake_at: string | null;
  page_cursor_at: string | null;
  page_cursor_slug: string;
  fact_cursor_at: string | null;
  fact_cursor_id: number;
}

function safeId(value: string | null | undefined, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (normalized || fallback).slice(0, ID_MAX);
}

function stringArray(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100)
    : [];
}

function manifest(value: unknown): CheckpointLink[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is CheckpointLink => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Partial<CheckpointLink>;
    return typeof row.slug === 'string'
      && typeof row.title === 'string'
      && typeof row.at === 'string'
      && typeof row.segment === 'string';
  }).slice(0, MANIFEST_CAP);
}

export async function getSessionContextState(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
): Promise<SessionContextState | null> {
  try {
    const rows = await engine.executeRaw<{
      standing_entities: unknown;
      surfaced_slugs: unknown;
      checkpoint_manifest: unknown;
      last_wake_at: string | Date | null;
      page_cursor_at: string | Date | null;
      page_cursor_slug: string | null;
      fact_cursor_at: string | Date | null;
      fact_cursor_id: number | string | null;
    }>(
      `SELECT standing_entities, surfaced_slugs, checkpoint_manifest, last_wake_at,
              page_cursor_at, page_cursor_slug, fact_cursor_at, fact_cursor_id
         FROM session_context_state
        WHERE source_id = $1 AND client_id = $2 AND session_id = $3`,
      [safeId(sourceId, 'default'), safeId(clientId, LOCAL_CONTEXT_CLIENT), safeId(sessionId, 'session')],
    );
    const row = rows[0];
    if (!row) return null;
    const wake = row.last_wake_at instanceof Date
      ? row.last_wake_at.toISOString()
      : row.last_wake_at ? String(row.last_wake_at) : null;
    const pageCursorAt = row.page_cursor_at instanceof Date
      ? row.page_cursor_at.toISOString()
      : row.page_cursor_at ? String(row.page_cursor_at) : null;
    const factCursorAt = row.fact_cursor_at instanceof Date
      ? row.fact_cursor_at.toISOString()
      : row.fact_cursor_at ? String(row.fact_cursor_at) : null;
    return {
      standing_entities: stringArray(row.standing_entities),
      surfaced_slugs: stringArray(row.surfaced_slugs),
      checkpoint_manifest: manifest(row.checkpoint_manifest),
      last_wake_at: wake,
      page_cursor_at: pageCursorAt,
      page_cursor_slug: row.page_cursor_slug ?? '',
      fact_cursor_at: factCursorAt,
      fact_cursor_id: Number(row.fact_cursor_id ?? 0),
    };
  } catch {
    return null;
  }
}

export async function upsertSessionContextState(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
  patch: {
    standingEntities?: string[];
    surfacedSlugs?: string[];
    checkpointManifest?: CheckpointLink[];
    lastWakeAt?: string | null;
    pageCursorAt?: string | null;
    pageCursorSlug?: string | null;
    factCursorAt?: string | null;
    factCursorId?: number | null;
  },
): Promise<boolean> {
  try {
    const replaceEntities = Array.isArray(patch.standingEntities);
    const replaceSlugs = Array.isArray(patch.surfacedSlugs);
    const replaceManifest = Array.isArray(patch.checkpointManifest);
    const replaceWake = patch.lastWakeAt !== undefined;
    const replacePageAt = patch.pageCursorAt !== undefined;
    const replacePageSlug = patch.pageCursorSlug !== undefined;
    const replaceFactAt = patch.factCursorAt !== undefined;
    const replaceFactId = patch.factCursorId !== undefined;
    await engine.executeRaw(
      `INSERT INTO session_context_state
         (source_id, client_id, session_id, standing_entities, surfaced_slugs,
          checkpoint_manifest, last_wake_at, page_cursor_at, page_cursor_slug,
          fact_cursor_at, fact_cursor_id, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6::text::jsonb,
               $7, $8, $9, $10, $11, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         standing_entities = CASE WHEN $12::boolean THEN EXCLUDED.standing_entities ELSE session_context_state.standing_entities END,
         surfaced_slugs = CASE WHEN $13::boolean THEN EXCLUDED.surfaced_slugs ELSE session_context_state.surfaced_slugs END,
         checkpoint_manifest = CASE WHEN $14::boolean THEN EXCLUDED.checkpoint_manifest ELSE session_context_state.checkpoint_manifest END,
         last_wake_at = CASE WHEN $15::boolean THEN EXCLUDED.last_wake_at ELSE session_context_state.last_wake_at END,
         page_cursor_at = CASE WHEN $16::boolean THEN EXCLUDED.page_cursor_at ELSE session_context_state.page_cursor_at END,
         page_cursor_slug = CASE WHEN $17::boolean THEN EXCLUDED.page_cursor_slug ELSE session_context_state.page_cursor_slug END,
         fact_cursor_at = CASE WHEN $18::boolean THEN EXCLUDED.fact_cursor_at ELSE session_context_state.fact_cursor_at END,
         fact_cursor_id = CASE WHEN $19::boolean THEN EXCLUDED.fact_cursor_id ELSE session_context_state.fact_cursor_id END,
         updated_at = now()`,
      [
        safeId(sourceId, 'default'),
        safeId(clientId, LOCAL_CONTEXT_CLIENT),
        safeId(sessionId, 'session'),
        JSON.stringify((patch.standingEntities ?? []).filter(Boolean).slice(0, 100)),
        JSON.stringify((patch.surfacedSlugs ?? []).filter(Boolean).slice(0, 500)),
        JSON.stringify((patch.checkpointManifest ?? []).slice(0, MANIFEST_CAP)),
        patch.lastWakeAt ?? null,
        patch.pageCursorAt ?? null,
        patch.pageCursorSlug ?? '',
        patch.factCursorAt ?? null,
        patch.factCursorId ?? 0,
        replaceEntities,
        replaceSlugs,
        replaceManifest,
        replaceWake,
        replacePageAt,
        replacePageSlug,
        replaceFactAt,
        replaceFactId,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export async function appendCheckpointManifest(
  engine: BrainEngine,
  sourceId: string,
  clientId: string | null | undefined,
  sessionId: string,
  links: Array<{ slug: string; title: string }>,
  segment: string,
): Promise<boolean> {
  const current = await getSessionContextState(engine, sourceId, clientId, sessionId);
  if (current === null && links.length === 0) return true;
  const at = new Date().toISOString();
  const fresh = links.map((link) => ({
    slug: safeId(link.slug, ''),
    title: link.title.replace(/\s+/g, ' ').trim().slice(0, 300),
    at,
    segment: safeId(segment, 'unknown'),
  })).filter((link) => link.slug);
  const freshSlugs = new Set(fresh.map((link) => link.slug));
  const merged = [
    ...fresh,
    ...(current?.checkpoint_manifest ?? []).filter((link) => !freshSlugs.has(link.slug)),
  ].slice(0, MANIFEST_CAP);
  return upsertSessionContextState(engine, sourceId, clientId, sessionId, {
    checkpointManifest: merged,
  });
}

export async function gcSessionContextState(engine: BrainEngine, olderThanDays = 7): Promise<void> {
  try {
    await engine.executeRaw(
      `DELETE FROM session_context_state
        WHERE updated_at < now() - ($1 || ' days')::interval`,
      [String(Math.max(1, Math.floor(olderThanDays)))],
    );
  } catch {
    // Best-effort maintenance only.
  }
}
