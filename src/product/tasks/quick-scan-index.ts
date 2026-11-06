import { isAbsolute, relative, resolve } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { isOfficeFilePath } from '../../core/sync.ts';
import { syncFileManifestKey } from '../../core/sync-file-identity.ts';
import type { SyncFileManifest } from './sync-file-queue.ts';

const BATCH = 500;

export function quickScanManifestKey(sourceId: string, sourceRoot: string, relativePath: string) {
  return syncFileManifestKey({ options: { sourceId }, sourceRoot, relativePath });
}

export function fingerprintMatches(stored: { fingerprint: string }, fingerprint: string, compatible?: readonly string[]) {
  return stored.fingerprint === fingerprint || compatible?.includes(stored.fingerprint) === true;
}

export function classifyQuickScanStat(stored: SyncFileManifest | undefined, size: number, mtimeMs: number, fingerprint: string, compatible?: readonly string[], ctimeMs?: number) {
  if (!stored || stored.size == null || stored.mtime == null || stored.size !== size || stored.mtime !== mtimeMs) return 'read' as const;
  if (ctimeMs !== undefined && stored.ctime != null && stored.ctime !== ctimeMs) return 'read' as const;
  if (ctimeMs !== undefined && stored.ctime == null) return 'read' as const;
  if (stored.repairRequired) return 'same-bytes' as const;
  return fingerprintMatches(stored, fingerprint, compatible) ? 'unchanged' as const : 'same-bytes' as const;
}

export function classifyQuickScanHash(stored: SyncFileManifest | undefined, hash: string, fingerprint: string, compatible: readonly string[] | undefined, size: number, mtimeMs: number, ctimeMs?: number) {
  if (stored && stored.hash === hash && fingerprintMatches(stored, fingerprint, compatible)) {
    return { unchanged: true, refresh: stored.size !== size || stored.mtime !== mtimeMs || (ctimeMs !== undefined && stored.ctime !== ctimeMs) };
  }
  return { unchanged: false, refresh: false };
}

export function refreshedManifest(stored: SyncFileManifest, size: number, mtimeMs: number, ctimeMs?: number): SyncFileManifest {
  const { repairRequired: _repairRequired, ...persistent } = stored;
  return { ...persistent, size, mtime: mtimeMs, ...(ctimeMs !== undefined ? { ctime: ctimeMs } : {}) };
}

function parseManifest(raw: string): SyncFileManifest | undefined {
  try {
    const value = JSON.parse(raw) as SyncFileManifest;
    if (!value || typeof value.hash !== 'string' || typeof value.fingerprint !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function insideRoot(root: string, filePath: string) {
  const rel = relative(resolve(root), resolve(filePath));
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

function quickScanRelativeBase(sourceRoot: string, root: string, paths: readonly string[]) {
  if (sourceRoot && paths.length > 0 && paths.every(path => insideRoot(sourceRoot, path))) return sourceRoot;
  return root;
}

export async function loadQuickScanFingerprints(engine: BrainEngine, sourceId: string, sourceRoot: string, root: string, paths: readonly string[]) {
  const index = new Map<string, SyncFileManifest>();
  const base = quickScanRelativeBase(sourceRoot, root, paths);
  const keys = paths.map(path => quickScanManifestKey(sourceId, sourceRoot, relative(base, path)));
  const officeKeys = new Set(paths.flatMap((path, index) => isOfficeFilePath(path) ? [keys[index]!] : []));
  for (let offset = 0; offset < keys.length; offset += BATCH) {
    const batch = keys.slice(offset, offset + BATCH);
    const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [batch]);
    for (const row of rows) {
      const manifest = parseManifest(row.value);
      if (manifest) index.set(row.key, manifest);
    }
  }
  const manifests = [...index.entries()];
  for (let offset = 0; offset < manifests.length; offset += BATCH) {
    const batch = manifests.slice(offset, offset + BATCH);
    const slugs = [...new Set(batch.map(([, manifest]) => manifest.slug))];
    const pages = await engine.executeRaw<{ slug: string; content_hash: string; chunks: number; chunk_hash: string }>(`SELECT p.slug,p.content_hash,count(c.id)::int AS chunks,
      md5(COALESCE(string_agg(c.chunk_index::text||':'||md5(c.chunk_text)||':'||c.chunk_source,',' ORDER BY c.chunk_index),'')) AS chunk_hash
      FROM pages p LEFT JOIN content_chunks c ON c.page_id=p.id
      WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL GROUP BY p.id`, [sourceId, slugs]);
    const pageBySlug = new Map(pages.map(page => [page.slug, page]));
    for (const [key, manifest] of batch) {
      const page = pageBySlug.get(manifest.slug);
      if (!page || page.content_hash !== manifest.pageHash || manifest.chunks == null || Number(manifest.chunks) !== Number(page.chunks)
        || (!manifest.chunkHash && !officeKeys.has(key)) || (manifest.chunkHash && manifest.chunkHash !== page.chunk_hash)) {
        manifest.repairRequired = true;
      }
    }
  }
  return index;
}

export async function saveQuickScanFingerprints(engine: BrainEngine, rows: ReadonlyArray<{ key: string; value: string }>) {
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const batch = rows.slice(offset, offset + BATCH);
    await engine.executeRaw(`INSERT INTO config (key, value)
      SELECT key, value FROM unnest($1::text[], $2::text[]) AS incoming(key, value)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [batch.map(row => row.key), batch.map(row => row.value)]);
  }
}
