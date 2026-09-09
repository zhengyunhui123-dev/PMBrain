import type { BrainEngine } from '../engine.ts';
import { isUndefinedTableError, warnOncePerProcess } from '../utils.ts';

export function transcriptStateKey(filePath: string, contentHash16: string): string {
  return `${filePath}\u0000${contentHash16}`;
}

export async function tombstonedTranscriptsForHashes(
  engine: BrainEngine,
  sourceId: string,
  contentHash16s: string[],
): Promise<Set<string>> {
  if (contentHash16s.length === 0) return new Set();
  try {
    const rows = await engine.executeRaw<{ file_path: string; content_hash: string }>(
      `SELECT file_path, content_hash
         FROM extract_atoms_transcript_state
        WHERE source_id = $1
          AND tombstoned
          AND content_hash = ANY($2::text[])`,
      [sourceId, contentHash16s],
    );
    return new Set(rows.map(r => transcriptStateKey(r.file_path, r.content_hash)));
  } catch (err) {
    if (isUndefinedTableError(err)) {
      warnOncePerProcess(
        'extract_atoms.transcript_state_missing',
        '[extract_atoms] extract_atoms_transcript_state is missing; transcript tombstones are off until migrate.',
      );
      return new Set();
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[extract_atoms] transcript tombstone check failed (assuming none tombstoned): ${msg}`);
    return new Set();
  }
}

export async function stampTranscriptTombstone(
  engine: BrainEngine,
  sourceId: string,
  filePath: string,
  contentHash: string,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO extract_atoms_transcript_state
         (source_id, file_path, content_hash, fail_count, tombstoned, updated_at)
       VALUES ($1, $2, $3, 0, TRUE, now())
       ON CONFLICT (source_id, file_path, content_hash)
       DO UPDATE SET tombstoned = TRUE, updated_at = now()`,
      [sourceId, filePath, contentHash.slice(0, 16)],
    );
  } catch {
    // Fail-soft: transcript stays rediscoverable.
  }
}

export async function recordTranscriptFailureCount(
  engine: BrainEngine,
  sourceId: string,
  filePath: string,
  contentHash: string,
): Promise<number | null> {
  try {
    const rows = await engine.executeRaw<{ cnt: number | string }>(
      `INSERT INTO extract_atoms_transcript_state
         (source_id, file_path, content_hash, fail_count, updated_at)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (source_id, file_path, content_hash)
       DO UPDATE SET fail_count = extract_atoms_transcript_state.fail_count + 1,
                     updated_at = now()
       RETURNING fail_count AS cnt`,
      [sourceId, filePath, contentHash.slice(0, 16)],
    );
    const cnt = rows[0]?.cnt;
    return cnt == null ? null : Number(cnt);
  } catch (err) {
    if (!isUndefinedTableError(err)) {
      console.error(`[extract_atoms] transcript failure-count write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}
