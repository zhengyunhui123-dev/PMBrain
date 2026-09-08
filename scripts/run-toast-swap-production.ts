import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyPgliteDirectory } from '../src/core/pglite-toast-repair.ts';
import { clearReapMarker as clearLockReap } from '../src/core/pglite-lock.ts';
import { clearRepairAttemptSidecar } from '../src/core/pglite-repair.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const repair = 'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy-3\\brain.pglite';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const preserved = `${production}.pre-toast-repair-${stamp}`;

if (!existsSync(repair)) throw new Error(`repair copy missing: ${repair}`);
if (!existsSync(production)) throw new Error(`production missing: ${production}`);
if (existsSync(preserved)) throw new Error(`preserve path already exists: ${preserved}`);

console.log(`rename ${production} -> ${preserved}`);
renameSync(production, preserved);
try {
  console.log(`copy ${repair} -> ${production}`);
  copyPgliteDirectory(repair, production);
} catch (error) {
  if (!existsSync(production) && existsSync(preserved)) {
    renameSync(preserved, production);
    console.log('copy failed; rolled production back');
  }
  throw error;
}

clearLockReap(production);
clearRepairAttemptSidecar(production);

const engine = new PGLiteEngine();
try {
  await engine.connect({ engine: 'pglite', database_path: production });
  await engine.initSchema();
  const pages = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages');
  const chunks = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM content_chunks');
  const facts = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM facts');
  await engine.executeRaw('SELECT length(compiled_truth) FROM pages');
  await engine.executeRaw('SELECT length(chunk_text) FROM content_chunks');
  console.log(JSON.stringify({
    status: 'replaced',
    production,
    preserved,
    repair,
    pages: pages[0]?.n,
    chunks: chunks[0]?.n,
    facts: facts[0]?.n,
  }, null, 2));
} catch (error) {
  await engine.disconnect().catch(() => {});
  if (existsSync(production)) rmSync(production, { recursive: true, force: true });
  renameSync(preserved, production);
  console.log('verify failed; rolled production back');
  throw error;
}
await engine.disconnect();
