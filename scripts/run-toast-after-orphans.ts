import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isPgliteToastInconsistencyError, parsePgliteToastError } from '../src/core/pglite-errors.ts';

const staging = 'D:\\backups\\.toast-forensic-20260908T214800Z\\diagnose-live\\brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: staging });

async function probe(sql: string) {
  try {
    await engine.executeRaw(sql);
    return { hit: false };
  } catch (error) {
    return {
      hit: true,
      toast: isPgliteToastInconsistencyError(error) ? parsePgliteToastError(error) : String(error),
    };
  }
}

const whereLive = 'page_id NOT IN (926, 2114) AND EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id)';
const result = {
  chunkTextLivePages: await probe(`SELECT length(chunk_text) FROM content_chunks WHERE ${whereLive}`),
  searchLivePages: await probe(`SELECT length(search_vector::text) FROM content_chunks WHERE ${whereLive}`),
  embeddingLivePages: await probe(`SELECT length(embedding::text) FROM content_chunks WHERE ${whereLive}`),
  allChunkText: await probe('SELECT length(chunk_text) FROM content_chunks'),
  page2114: await engine.executeRaw(`SELECT id, slug, title FROM pages WHERE id = 2114`),
  orphanPages: await engine.executeRaw(`
    SELECT c.page_id, COUNT(*)::int AS n
    FROM content_chunks c
    LEFT JOIN pages p ON p.id = c.page_id
    WHERE p.id IS NULL
    GROUP BY c.page_id
    ORDER BY c.page_id
  `),
};

console.log(JSON.stringify(result, null, 2));
await engine.disconnect();
