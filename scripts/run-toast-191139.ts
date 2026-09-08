import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isPgliteToastInconsistencyError, parsePgliteToastError } from '../src/core/pglite-errors.ts';

const staging = 'D:\\backups\\.toast-forensic-20260908T214800Z\\diagnose-live\\brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: staging });

async function hits(sql: string, params: unknown[]) {
  try {
    await engine.executeRaw(sql, params);
    return { hit: false as const };
  } catch (error) {
    if (!isPgliteToastInconsistencyError(error)) throw error;
    return { hit: true as const, toast: parsePgliteToastError(error) };
  }
}

async function findId(extraWhere: string, column: string) {
  const bounds = await engine.executeRaw<{ lo: number; hi: number }>(
    `SELECT MIN(id)::int AS lo, MAX(id)::int AS hi FROM content_chunks WHERE ${extraWhere}`,
  );
  let low = Number(bounds[0]?.lo);
  let high = Number(bounds[0]?.hi);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const first = await hits(
    `SELECT length(${column}::text) FROM content_chunks WHERE id >= $1 AND id <= $2 AND ${extraWhere}`,
    [low, high],
  );
  if (!first.hit) return { id: null, toast: null, range: [low, high] };
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const left = await hits(
      `SELECT length(${column}::text) FROM content_chunks WHERE id >= $1 AND id <= $2 AND ${extraWhere}`,
      [low, mid],
    );
    if (left.hit) high = mid;
    else low = mid + 1;
  }
  const light = await engine.executeRaw(
    `SELECT id, page_id, chunk_index, ctid::text AS ctid FROM content_chunks WHERE id = $1`,
    [low],
  );
  return { id: low, row: light[0], toast: first.toast };
}

const text191139 = await findId('id <> 55978', 'chunk_text');
const searchAll = await findId('true', 'search_vector');
const orphans = await engine.executeRaw(`
  SELECT c.id, c.page_id, c.chunk_index
  FROM content_chunks c
  LEFT JOIN pages p ON p.id = c.page_id
  WHERE p.id IS NULL
  ORDER BY c.page_id, c.id
`);

const missingPageIds = [...new Set(orphans.map((row: { page_id: number }) => row.page_id))];

console.log(JSON.stringify({
  textExcluding55978: text191139,
  searchVector: searchAll,
  orphanCount: orphans.length,
  missingPageIds,
  orphanSample: orphans.slice(0, 20),
}, null, 2));

await engine.disconnect();
