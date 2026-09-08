import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isPgliteToastInconsistencyError, parsePgliteToastError } from '../src/core/pglite-errors.ts';

const staging = 'D:\\backups\\.toast-forensic-20260908T214800Z\\diagnose-live\\brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: staging });

const page = await engine.executeRaw(`SELECT id, source_id, slug, title, deleted_at IS NOT NULL AS deleted FROM pages WHERE id = 926`);
const nearby = await engine.executeRaw(`SELECT id, source_id, slug, title FROM pages WHERE id BETWEEN 920 AND 930 ORDER BY id`);
const chunksFor926 = await engine.executeRaw(`SELECT id, chunk_index FROM content_chunks WHERE page_id = 926 ORDER BY chunk_index`);
const maxPage = await engine.executeRaw(`SELECT MAX(id)::int AS n FROM pages`);
const orphan = await engine.executeRaw(`
  SELECT COUNT(*)::int AS n
  FROM content_chunks c
  LEFT JOIN pages p ON p.id = c.page_id
  WHERE p.id IS NULL
`);

const columns = ['chunk_text', 'search_vector', 'embedding', 'doc_comment', 'embedded_text_hash', 'chunk_source'];
const otherHits: unknown[] = [];
for (const column of columns) {
  try {
    await engine.executeRaw(`SELECT length(${column}::text) FROM content_chunks WHERE id <> 55978`);
    otherHits.push({ column, hit: false });
  } catch (error) {
    otherHits.push({
      column,
      hit: true,
      toast: isPgliteToastInconsistencyError(error) ? parsePgliteToastError(error) : String(error),
    });
  }
}

let pagesBodyOk = true;
let pagesBodyError: string | null = null;
try {
  await engine.executeRaw(`SELECT length(compiled_truth) FROM pages`);
} catch (error) {
  pagesBodyOk = false;
  pagesBodyError = error instanceof Error ? error.message : String(error);
}

console.log(JSON.stringify({
  page926: page,
  nearby,
  chunksFor926,
  maxPage,
  orphanChunks: orphan,
  otherHits,
  pagesBodyOk,
  pagesBodyError,
}, null, 2));

await engine.disconnect();
