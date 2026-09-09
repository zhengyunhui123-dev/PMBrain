import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  copyPgliteDirectory,
  diagnosePgliteToast,
} from '../src/core/pglite-toast-repair.ts';

const production = 'C:\\Users\\zhengyunhui\\.pmbrain\\brain.pglite';
const backup179 = 'D:\\backups\\20260908T102331309Z-1.1.79-943b81a5\\brain.pglite';
const backup176 = 'D:\\backups\\20260908T053003935Z-1.1.76-92e8d2ce\\brain.pglite';
const backup173 = 'D:\\backups\\20260904T031004615Z-1.1.73-5a07ad2f\\brain.pglite';
const root = 'D:\\backups\\.toast-forensic-20260908T214800Z';

function mustCopy(source: string, dest: string): void {
  if (!existsSync(source)) throw new Error(`missing source ${source}`);
  if (existsSync(dest)) {
    console.log(`reuse existing copy ${dest}`);
    return;
  }
  console.log(`copy ${source} -> ${dest}`);
  mkdirSync(join(dest, '..'), { recursive: true });
  copyPgliteDirectory(source, dest);
}

const targets = [
  { name: 'untouched-live', source: production, diagnose: false },
  { name: 'diagnose-live', source: production, diagnose: true },
  { name: 'diagnose-1.1.79', source: backup179, diagnose: true },
] as const;

mkdirSync(root, { recursive: true });
const summary: unknown[] = [];

for (const target of targets) {
  const dest = join(root, target.name, 'brain.pglite');
  mustCopy(target.source, dest);
  if (!target.diagnose) continue;
  console.log(`diagnose ${target.name}`);
  const report = await diagnosePgliteToast({
    stagingPath: dest,
    productionPath: production,
    forensicWalReset: true,
  });
  console.log(JSON.stringify({
    name: target.name,
    status: report.status,
    table: report.baseTable,
    column: report.column,
    row: report.row,
    repairability: report.repairability,
    chunks: report.toastChunks,
    forensicWalResetUsed: report.forensicWalResetUsed,
    error: report.error,
    logPath: report.logPath,
  }, null, 2));
  summary.push({ name: target.name, report });
}

writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`wrote ${join(root, 'summary.json')}`);

if (summary.some((item: any) => item.report?.toast?.toastValue === 191139 && item.report?.status !== 'healthy')) {
  for (const extra of [
    { name: 'diagnose-1.1.76', source: backup176 },
    { name: 'diagnose-1.1.73', source: backup173 },
  ]) {
    if (!existsSync(extra.source)) {
      console.log(`skip missing ${extra.source}`);
      continue;
    }
    const dest = join(root, extra.name, 'brain.pglite');
    mustCopy(extra.source, dest);
    console.log(`diagnose ${extra.name}`);
    const report = await diagnosePgliteToast({
      stagingPath: dest,
      productionPath: production,
      forensicWalReset: true,
    });
    console.log(JSON.stringify({
      name: extra.name,
      status: report.status,
      table: report.baseTable,
      column: report.column,
      row: report.row,
      repairability: report.repairability,
      chunks: report.toastChunks,
      forensicWalResetUsed: report.forensicWalResetUsed,
      error: report.error,
    }, null, 2));
    summary.push({ name: extra.name, report });
    writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  }
}
