import { writeFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { verifyStagingPgliteHealth } from '../src/core/pglite-toast-repair.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const repair = 'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-3\\brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: repair });

const keep = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks_keep');
const edges = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM code_edges_chunk');
if (Number(edges[0]?.n ?? 0) !== 0) {
  throw new Error(`Refusing CASCADE truncate; code_edges_chunk has ${edges[0]?.n} rows`);
}
await engine.executeRaw('TRUNCATE content_chunks CASCADE');
await engine.executeRaw('INSERT INTO content_chunks SELECT * FROM content_chunks_keep');
const after = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks');
const orphans = await engine.executeRaw<{ n: number }>(`
  SELECT COUNT(*)::int AS n
  FROM content_chunks c
  LEFT JOIN pages p ON p.id = c.page_id
  WHERE p.id IS NULL
`);
await engine.disconnect();
console.log(JSON.stringify({ keep: keep[0]?.n, after: after[0]?.n, orphans: orphans[0]?.n }));

const health = await verifyStagingPgliteHealth(repair, production);
console.log('health', JSON.stringify(health, null, 2));
writeFileSync(
  'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-3-verify.json',
  JSON.stringify({ keep, after, orphans, health }, null, 2),
);
