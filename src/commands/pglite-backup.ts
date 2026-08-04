import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir, gbrainPath, loadConfig } from '../core/config.ts';
import {
  createVerifiedPgliteUpgradeBackup,
  listPgliteUpgradeBackups,
  verifyPgliteUpgradeBackup,
  type PgliteUpgradeBackupSummary,
  type PgliteUpgradeBackupResult,
} from '../core/pglite-upgrade-backup.ts';

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function printJson(result: unknown): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function fail(json: boolean, reason: string, message: string): never {
  if (json) printJson({ status: 'error', reason, message });
  else process.stderr.write(message + '\n');
  process.exit(1);
}

function printHuman(result: PgliteUpgradeBackupResult): void {
  const action = result.status === 'created' ? '已创建并验证' : result.status === 'reused' ? '已复用并重新验证' : '验证通过';
  process.stdout.write(
    `${action} PGLite 升级冷备。\n` +
    `  备份目录：${result.backupDirectory}\n` +
    `  Schema：${result.manifest.source_schema_version ?? 'unknown'}\n` +
    `  文件：${result.manifest.backup_inventory.files}\n` +
    `  字节：${result.manifest.backup_inventory.bytes}\n` +
    `  SHA-256：${result.manifest.backup_inventory.sha256}\n` +
    '恢复验证已在一次性副本上完成；活动数据库和冷备本体均未被打开迁移。\n',
  );
}

function printListHuman(databasePath: string, backups: PgliteUpgradeBackupSummary[]): void {
  if (backups.length === 0) {
    process.stdout.write(`未找到该数据库的已验证升级备份：${databasePath}\n`);
    return;
  }
  process.stdout.write(`已验证的 PGLite 升级备份（${databasePath}）：\n`);
  for (const backup of backups) {
    process.stdout.write(
      `  升级目标：v${backup.manifest.target_version}；Schema：${backup.manifest.source_schema_version ?? 'unknown'}；` +
      `创建时间：${backup.manifest.created_at}\n` +
      `  备份目录：${backup.backupDirectory}\n`,
    );
  }
}

export async function runPgliteBackup(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const subcommand = args[0] ?? 'help';
  if (subcommand === 'help' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage:
  pmbrain pglite-backup create --target-version <version> [--path <brain.pglite>] [--json]
  pmbrain pglite-backup list [--path <brain.pglite>] [--json]
  pmbrain pglite-backup verify --backup <backup-directory> [--json]

create acquires the single-owner migration lock, copies the closed database to
the active PMBrain config directory's backups/pglite-upgrades folder, verifies
byte integrity, then opens only a disposable restore copy to read schema version
and protected table counts.

verify re-checks SHA-256 and repeats the disposable-copy recovery test. It does
not overwrite or restore the active database automatically.

list reads verified backup manifests only. It does not open, restore, modify, or
delete the active database or any backup.
`);
    return;
  }

  try {
    if (subcommand === 'list') {
      const cfg = loadConfig();
      if (cfg?.engine !== 'pglite') {
        fail(json, 'not_pglite', `PGLite backup listing requires a PGLite configuration (current: ${cfg?.engine ?? 'none'}).`);
      }
      const databasePath = resolve(valueAfter(args, '--path') || cfg.database_path || gbrainPath('brain.pglite'));
      const backups = listPgliteUpgradeBackups(
        join(configDir(), 'backups', 'pglite-upgrades'),
        databasePath,
      );
      const result = {
        status: 'ok',
        database_path: databasePath,
        backups: backups.map(backup => ({
          status: backup.manifest.status,
          backup_directory: backup.backupDirectory,
          backup_database_path: backup.backupDatabasePath,
          manifest_path: backup.manifestPath,
          created_at: backup.manifest.created_at,
          target_version: backup.manifest.target_version,
          source_schema_version: backup.manifest.source_schema_version,
          recovery_verified_at: backup.manifest.recovery_validation.verified_at,
        })),
      };
      if (json) printJson(result);
      else printListHuman(databasePath, backups);
      return;
    }

    if (subcommand === 'create') {
      const cfg = loadConfig();
      if (cfg?.engine !== 'pglite') {
        fail(json, 'not_pglite', `PGLite cold backup requires a PGLite configuration (current: ${cfg?.engine ?? 'none'}).`);
      }
      const databasePath = resolve(valueAfter(args, '--path') || cfg.database_path || gbrainPath('brain.pglite'));
      const targetVersion = valueAfter(args, '--target-version')?.trim();
      if (!targetVersion) fail(json, 'missing_target_version', '--target-version <version> is required.');
      if (!existsSync(databasePath)) {
        const result = { status: 'not_required', reason: 'database_missing', database_path: databasePath };
        if (json) printJson(result);
        else process.stdout.write(`PGLite 数据库尚不存在，无需创建升级备份：${databasePath}\n`);
        return;
      }
      const result = await createVerifiedPgliteUpgradeBackup({
        databasePath,
        targetVersion,
        backupRoot: join(configDir(), 'backups', 'pglite-upgrades'),
      });
      if (json) printJson({
        status: result.status,
        backup_directory: result.backupDirectory,
        backup_database_path: result.backupDatabasePath,
        manifest_path: result.manifestPath,
        schema_version: result.manifest.source_schema_version,
        sha256: result.manifest.backup_inventory.sha256,
        protected_table_counts: result.manifest.recovery_validation.protected_table_counts,
      });
      else printHuman(result);
      return;
    }

    if (subcommand === 'verify') {
      const backup = valueAfter(args, '--backup');
      if (!backup) fail(json, 'missing_backup', '--backup <backup-directory> is required.');
      const result = await verifyPgliteUpgradeBackup(resolve(backup));
      if (json) printJson({
        status: result.status,
        backup_directory: result.backupDirectory,
        schema_version: result.manifest.source_schema_version,
        sha256: result.manifest.backup_inventory.sha256,
        protected_table_counts: result.manifest.recovery_validation.protected_table_counts,
      });
      else printHuman(result);
      return;
    }

    fail(json, 'unknown_subcommand', `Unknown pglite-backup subcommand: ${subcommand}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(json, 'backup_failed', message);
  }
}
