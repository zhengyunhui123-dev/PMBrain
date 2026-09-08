import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOrphanContentChunkRepair,
  copyPgliteDirectory,
  verifyStagingPgliteHealth,
} from '../src/core/pglite-toast-repair.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const untouched = 'D:\\backups\\.toast-forensic-20260908T214800Z\\untouched-live\\brain.pglite';
const repair = 'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-copy\\brain.pglite';

if (!existsSync(repair)) {
  mkdirSync(join(repair, '..'), { recursive: true });
  copyPgliteDirectory(untouched, repair);
}

const dry = await applyOrphanContentChunkRepair({
  stagingPath: repair,
  productionPath: production,
  apply: false,
});
console.log('dry-run', JSON.stringify(dry, null, 2));

const applied = await applyOrphanContentChunkRepair({
  stagingPath: repair,
  productionPath: production,
  apply: true,
});
console.log('applied', JSON.stringify(applied, null, 2));

const health = await verifyStagingPgliteHealth(repair, production);
console.log('health', JSON.stringify(health, null, 2));
writeFileSync(
  'D:\\backups\\.toast-forensic-20260908T214800Z\\repair-verify.json',
  JSON.stringify({ dry, applied, health }, null, 2),
);
