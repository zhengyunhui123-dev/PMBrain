import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isPgliteToastInconsistencyError, parsePgliteToastError } from '../src/core/pglite-errors.ts';

const staging = 'D:\\backups\\.toast-forensic-20260908T214800Z\\diagnose-live\\brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: staging });

async function hits(lo: number, hi: number) {
  try {
    await engine.executeRaw(
      `SELECT length(chunk_text) AS n FROM content_chunks WHERE id >= $1 AND id <= $2`,
      [lo, hi],
    );
    return { hit: false as const };
  } catch (error) {
    if (!isPgliteToastInconsistencyError(error)) throw error;
    return { hit: true as const, toast: parsePgliteToastError(error) };
  }
}

async function findOne(lo: number, hi: number): Promise<number | null> {
  const first = await hits(lo, hi);
  if (!first.hit) return null;
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const left = await hits(low, mid);
    if (left.hit) high = mid;
    else low = mid + 1;
  }
  return low;
}

const bounds = await engine.executeRaw<{ lo: number; hi: number }>(
  `SELECT MIN(id)::int AS lo, MAX(id)::int AS hi FROM content_chunks`,
);
let cursor = Number(bounds[0]!.lo);
const maxId = Number(bounds[0]!.hi);
const found: Array<Record<string, unknown>> = [];

while (cursor <= maxId && found.length < 200) {
  const id = await findOne(cursor, maxId);
  if (id == null) break;
  const light = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, page_id, chunk_index, ctid::text AS ctid FROM content_chunks WHERE id = $1`,
    [id],
  );
  const pageId = Number(light[0]?.page_id);
  let page: Record<string, unknown> | null = null;
  let pageReadable = false;
  try {
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT id, source_id, slug, title, length(compiled_truth) AS body_len FROM pages WHERE id = $1`,
      [pageId],
    );
    page = rows[0] ?? null;
    pageReadable = true;
  } catch (error) {
    page = { error: error instanceof Error ? error.message : String(error) };
  }
  const item = { chunk: light[0], page, pageReadable, toast: (await hits(id, id)).toast };
  found.push(item);
  console.log(JSON.stringify(item));
  cursor = id + 1;
}

const pagesOk = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages`);
const chunksOk = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM content_chunks`);
let factsN = 0;
try {
  const facts = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM facts`);
  factsN = Number(facts[0]?.n ?? 0);
} catch (error) {
  console.log('facts count failed', error instanceof Error ? error.message : error);
}

console.log(JSON.stringify({
  found: found.length,
  pageCount: pagesOk[0]?.n,
  chunkCount: chunksOk[0]?.n,
  factCount: factsN,
  uniquePages: [...new Set(found.map(item => (item.chunk as { page_id?: number }).page_id))],
}, null, 2));

await engine.disconnect();
