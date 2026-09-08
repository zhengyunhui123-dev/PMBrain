import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyOrphanContentChunkRepair,
  applyPgliteToastRepair,
  assertStagingNotProduction,
  copyPgliteDirectory,
  defaultForensicRoot,
  diagnosePgliteToast,
  replaceProductionWithStaging,
  resolveProductionPglitePath,
} from '../core/pglite-toast-repair.ts';

const HELP = `pmbrain repair — PGLite 数据级修复（默认只读，不碰正式库）

用法
  pmbrain repair toast-diagnose [--path DIR] [--staging DIR] [--json] [--forensic-wal-reset]
  pmbrain repair toast --staging DIR [--apply] [--orphan-chunks] [--table T] [--column C] [--id N] [--json]
  pmbrain repair toast-replace --staging DIR --yes [--path DIR] [--json]

说明
  toast-diagnose  复制正式库到 staging（若未指定），只读定位 toast 损坏行
  toast           默认 dry-run。只有 --apply 才会在明确的 staging 上修改
                  --apply 永远不能指向当前正式 brain.pglite
  toast-replace   用户确认后，用已修复 staging 替换正式库；正式库改名为 pre-toast-repair-*

  不会 DROP TABLE、不会重建整库、不会重建全部向量。
`;

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T').replace(/Z$/, 'Z');
}

export async function runRepairCli(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const json = args.includes('--json');
  const subcommand = args[0];

  if (subcommand === 'toast-diagnose') {
    const productionPath = resolveProductionPglitePath(valueAfter(args, '--path'));
    let stagingPath = valueAfter(args, '--staging');
    if (!stagingPath) {
      const root = defaultForensicRoot();
      stagingPath = join(root, `.toast-forensic-${stamp()}`, 'brain.pglite');
      mkdirSync(resolve(stagingPath, '..'), { recursive: true });
      copyPgliteDirectory(productionPath, stagingPath);
    } else {
      stagingPath = resolve(stagingPath);
      assertStagingNotProduction(stagingPath, productionPath);
      if (!existsSync(stagingPath)) {
        copyPgliteDirectory(productionPath, stagingPath);
      }
    }
    const report = await diagnosePgliteToast({
      stagingPath,
      productionPath,
      forensicWalReset: args.includes('--forensic-wal-reset'),
    });
    if (json) printJson(report);
    else {
      process.stdout.write(
        `toast-diagnose ${report.status}\n` +
        `  staging: ${report.stagingPath}\n` +
        `  production untouched: ${report.productionPath}\n` +
        `  receipt: ${report.logPath}\n` +
        (report.baseTable ? `  table: ${report.baseTable.schema}.${report.baseTable.name}\n` : '') +
        (report.column ? `  column: ${report.column}\n` : '') +
        (report.row ? `  row: ${JSON.stringify(report.row)}\n` : '') +
        (report.repairability ? `  repairability: ${report.repairability}\n` : '') +
        (report.recommendedAction ? `  next: ${report.recommendedAction}\n` : '') +
        (report.error ? `  error: ${report.error}\n` : ''),
      );
    }
    if (report.status === 'open-failed') process.exitCode = 1;
    return;
  }

  if (subcommand === 'toast') {
    const staging = valueAfter(args, '--staging');
    if (!staging) {
      process.stderr.write('repair toast requires --staging <path>\n');
      process.exitCode = 1;
      return;
    }
    const productionPath = resolveProductionPglitePath(valueAfter(args, '--path'));
    const table = valueAfter(args, '--table');
    const column = valueAfter(args, '--column');
    const id = valueAfter(args, '--id');
    const apply = args.includes('--apply');
    if (args.includes('--apply-orphan-chunks') || args.includes('--orphan-chunks')) {
      const report = await applyOrphanContentChunkRepair({
        stagingPath: resolve(staging),
        productionPath,
        apply,
      });
      if (json) printJson(report);
      else process.stdout.write(`${report.status}: deleted=${report.deleted ?? 0} ${report.action ?? report.error ?? ''}\nreceipt: ${report.logPath}\n`);
      if (report.status === 'refused') process.exitCode = 1;
      return;
    }
    if (!table || !column || !id) {
      const diagnose = await diagnosePgliteToast({
        stagingPath: resolve(staging),
        productionPath,
        forensicWalReset: args.includes('--forensic-wal-reset'),
      });
      if (diagnose.status !== 'located' || !diagnose.column || diagnose.row?.id == null) {
        if (json) printJson(diagnose);
        else process.stderr.write('toast row not located; refusing apply\n');
        process.exitCode = 1;
        return;
      }
      const report = await applyPgliteToastRepair({
        stagingPath: resolve(staging),
        productionPath,
        apply,
        table: diagnose.baseTable!.name,
        column: diagnose.column,
        id: diagnose.row.id,
      });
      if (json) printJson({ diagnose, apply: report });
      else process.stdout.write(`${report.status}: ${report.action ?? report.error ?? ''}\nreceipt: ${report.logPath}\n`);
      if (report.status === 'refused') process.exitCode = 1;
      return;
    }
    const report = await applyPgliteToastRepair({
      stagingPath: resolve(staging),
      productionPath,
      apply,
      table,
      column,
      id: /^\d+$/.test(id) ? Number(id) : id,
    });
    if (json) printJson(report);
    else process.stdout.write(`${report.status}: ${report.action ?? report.error ?? ''}\nreceipt: ${report.logPath}\n`);
    if (report.status === 'refused') process.exitCode = 1;
    return;
  }

  if (subcommand === 'toast-replace') {
    const staging = valueAfter(args, '--staging');
    if (!staging) {
      process.stderr.write('repair toast-replace requires --staging <path>\n');
      process.exitCode = 1;
      return;
    }
    if (!args.includes('--yes')) {
      process.stderr.write('repair toast-replace requires --yes because it replaces the active PGLite database.\n');
      process.exitCode = 1;
      return;
    }
    const productionPath = resolveProductionPglitePath(valueAfter(args, '--path'));
    const report = await replaceProductionWithStaging({
      stagingPath: resolve(staging),
      productionPath,
      yes: true,
    });
    if (json) printJson(report);
    else {
      process.stdout.write(
        `已用修复副本替换当前 PGLite 数据库。\n` +
        `  正式库：${report.productionPath}\n` +
        `  原库留底：${report.preservedPath}\n` +
        `  Pages ${report.pages} / Chunks ${report.chunks} / Facts ${report.facts}\n`,
      );
    }
    return;
  }

  process.stderr.write(HELP);
  process.exitCode = 1;
}
