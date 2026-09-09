import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPgliteDirectory, verifyStagingPgliteHealth } from '../src/core/pglite-toast-repair.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const untouched = 'D:\\backups\\.toast-forensic-20260908T214800Z\\untouched-live\\brain.pglite';
const repair = 'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-3\\brain.pglite';

mkdirSync(join(repair, '..'), { recursive: true });
copyPgliteDirectory(untouched, repair);

const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: repair });

const before = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks');
await engine.executeRaw(`
  CREATE TABLE content_chunks_keep AS
  SELECT *
  FROM content_chunks
  WHERE page_id NOT IN (926, 2114)
    AND EXISTS (SELECT 1 FROM pages p WHERE p.id = content_chunks.page_id)
`);
const kept = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks_keep');
console.log(JSON.stringify({ before: before[0]?.n, kept: kept[0]?.n }));

try {
  await engine.executeRaw('TRUNCATE content_chunks');
  console.log('truncate ok');
} catch (error) {
  console.log('truncate failed', error instanceof Error ? error.message : error);
  throw error;
}

await engine.executeRaw('INSERT INTO content_chunks SELECT * FROM content_chunks_keep');
const after = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks');
const orphans = await engine.executeRaw<{ n: number }>(`
  SELECT COUNT(*)::int AS n
  FROM content_chunks c
  LEFT JOIN pages p ON p.id = c.page_id
  WHERE p.id IS NULL
`);
await engine.executeRaw('DROP TABLE content_chunks_keep');
await engine.disconnect();
console.log(JSON.stringify({ after: after[0]?.n, orphans: orphans[0]?.n }));

const health = await verifyStagingPgliteHealth(repair, production);
console.log('health', JSON.stringify(health, null, 2));
writeFileSync(
  'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-3-verify.json',
  JSON.stringify({ before, kept, after, orphans, health }, null, 2),
);
