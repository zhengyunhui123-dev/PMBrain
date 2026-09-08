import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPgliteDirectory, verifyStagingPgliteHealth } from '../src/core/pglite-toast-repair.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const untouched = 'D:\\backups\\.toast-forensic-20260908T214800Z\\untouched-live\\brain.pglite';
const repair = 'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-2\\brain.pglite';

mkdirSync(join(repair, '..'), { recursive: true });
copyPgliteDirectory(untouched, repair);

const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: repair });
const orphans = await engine.executeRaw<{ id: number; page_id: number; chunk_index: number }>(`
  SELECT c.id, c.page_id, c.chunk_index
  FROM content_chunks c
  LEFT JOIN pages p ON p.id = c.page_id
  WHERE p.id IS NULL
  ORDER BY c.id
`);
console.log(`orphans=${orphans.length}`);

const results: Array<{ id: number; ok: boolean; error?: string }> = [];
for (const row of orphans) {
  try {
    await engine.executeRaw(`DELETE FROM content_chunks WHERE id = $1`, [row.id]);
    results.push({ id: row.id, ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ id: row.id, ok: false, error: message });
    try {
      await engine.executeRaw(
        `UPDATE content_chunks SET chunk_text = '', search_vector = NULL WHERE id = $1`,
        [row.id],
      );
      results[results.length - 1] = { id: row.id, ok: true, error: `delete failed; emptied instead: ${message}` };
    } catch (updateError) {
      results[results.length - 1].error = `${message} / update: ${updateError instanceof Error ? updateError.message : String(updateError)}`;
    }
  }
}

const leftover = await engine.executeRaw<{ n: number }>(`
  SELECT COUNT(*)::int AS n
  FROM content_chunks c
  LEFT JOIN pages p ON p.id = c.page_id
  WHERE p.id IS NULL
`);
await engine.disconnect();

const failed = results.filter(row => !row.ok);
console.log(JSON.stringify({
  deleted: results.filter(row => row.ok && !row.error).length,
  emptied: results.filter(row => row.ok && row.error).length,
  failed: failed.length,
  leftover: leftover[0]?.n,
  failedRows: failed,
}, null, 2));

const health = await verifyStagingPgliteHealth(repair, production);
console.log('health', JSON.stringify(health, null, 2));
writeFileSync(
  'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-2-verify.json',
  JSON.stringify({ results, leftover, health }, null, 2),
);
