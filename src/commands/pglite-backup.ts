import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gbrainPath, loadConfig, saveConfig } from '../core/config.ts';
import {
  createVerifiedPgliteUpgradeBackup,
  deletePgliteUpgradeBackup,
  listPgliteUpgradeBackups,
  preparePgliteUpgradeBackupRoot,
  prunePgliteUpgradeBackups,
  PGLITE_UPGRADE_BACKUP_RETENTION,
  resolvePgliteUpgradeBackupRoot,
  restorePgliteUpgradeBackup,
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

function requirePgliteConfig(json: boolean) {
  const cfg = loadConfig();
  if (cfg?.engine !== 'pglite') {
    fail(json, 'not_pglite', `PGLite backup commands require a PGLite configuration (current: ${cfg?.engine ?? 'none'}).`);
  }
  return cfg;
}

function resolveDatabasePath(args: string[], cfg: { database_path?: string }): string {
  return resolve(valueAfter(args, '--path') || cfg.database_path || gbrainPath('brain.pglite'));
}

function resolveBackupRoot(args: string[], cfg: { pglite_upgrade_backup_dir?: string } | null): string {
  return resolvePgliteUpgradeBackupRoot(valueAfter(args, '--backup-root') || cfg?.pglite_upgrade_backup_dir);
}

function serializeBackup(backup: PgliteUpgradeBackupSummary) {
  return {
    status: backup.manifest.status,
    backup_directory: backup.backupDirectory,
    backup_database_path: backup.backupDatabasePath,
    manifest_path: backup.manifestPath,
    created_at: backup.manifest.created_at,
    target_version: backup.manifest.target_version,
    source_schema_version: backup.manifest.source_schema_version,
    recovery_verified_at: backup.manifest.recovery_validation.verified_at,
    bytes: backup.manifest.backup_inventory.bytes,
  };
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

function printListHuman(databasePath: string, backupRoot: string, backups: PgliteUpgradeBackupSummary[]): void {
  const totalBytes = backups.reduce((sum, backup) => sum + backup.manifest.backup_inventory.bytes, 0);
  if (backups.length === 0) {
    process.stdout.write(`未找到该数据库的已验证升级备份：${databasePath}\n备份目录：${backupRoot}\n`);
    return;
  }
  process.stdout.write(
    `已验证的 PGLite 升级备份（${backups.length} 份，${totalBytes} 字节）：\n` +
    `  数据库：${databasePath}\n` +
    `  备份目录：${backupRoot}\n` +
    `  自动升级保留最近 ${PGLITE_UPGRADE_BACKUP_RETENTION} 份\n`,
  );
  for (const backup of backups) {
    process.stdout.write(
      `  升级目标：v${backup.manifest.target_version}；Schema：${backup.manifest.source_schema_version ?? 'unknown'}；` +
      `创建时间：${backup.manifest.created_at}；大小：${backup.manifest.backup_inventory.bytes} 字节\n` +
      `  备份目录：${backup.backupDirectory}\n`,
    );
  }
}

export async function runPgliteBackup(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const subcommand = args[0] ?? 'help';
  if (subcommand === 'help' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage:
  pmbrain pglite-backup create --target-version <version> [--path <brain.pglite>] [--backup-root <dir>] [--json]
  pmbrain pglite-backup list [--path <brain.pglite>] [--backup-root <dir>] [--json]
  pmbrain pglite-backup verify --backup <backup-directory> [--json]
  pmbrain pglite-backup prune [--path <brain.pglite>] [--keep 2] [--backup-root <dir>] [--json]
  pmbrain pglite-backup delete --backup <backup-directory> [--path <brain.pglite>] [--backup-root <dir>] [--json]
  pmbrain pglite-backup restore --backup <backup-directory> --yes [--path <brain.pglite>] [--backup-root <dir>] [--json]
  pmbrain pglite-backup set-root --dir <backup-directory> [--json]

create acquires the single-owner migration lock, copies the closed database to
the configured backup root (default <config-dir>/backups/pglite-upgrades),
verifies byte integrity, then opens only a disposable restore copy to read
schema version and protected table counts.

verify re-checks SHA-256 and repeats the disposable-copy recovery test. It does
not overwrite or restore the active database automatically.

list reads verified backup manifests only. It does not open, restore, modify, or
delete the active database or any backup.

prune deletes oldest verified backups for the selected database after a
successful upgrade, always keeping at least the newest 2 copies.

delete removes one verified backup directory. It never touches the active
database.

restore replaces the closed active database with a verified backup copy. The
backup itself is kept. Sidecar / other owners must be stopped first.

set-root writes pglite_upgrade_backup_dir. Existing backups are not moved.
`);
    return;
  }

  try {
    if (subcommand === 'list') {
      const cfg = requirePgliteConfig(json);
      const databasePath = resolveDatabasePath(args, cfg);
      const backupRoot = resolveBackupRoot(args, cfg);
      const backups = listPgliteUpgradeBackups(backupRoot, databasePath);
      const result = {
        status: 'ok',
        database_path: databasePath,
        backup_root: backupRoot,
        keep: PGLITE_UPGRADE_BACKUP_RETENTION,
        total_bytes: backups.reduce((sum, backup) => sum + backup.manifest.backup_inventory.bytes, 0),
        backups: backups.map(serializeBackup),
      };
      if (json) printJson(result);
      else printListHuman(databasePath, backupRoot, backups);
      return;
    }

    if (subcommand === 'create') {
      const cfg = requirePgliteConfig(json);
      const databasePath = resolveDatabasePath(args, cfg);
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
        backupRoot: resolveBackupRoot(args, cfg),
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

    if (subcommand === 'prune') {
      const cfg = requirePgliteConfig(json);
      const keepRaw = valueAfter(args, '--keep');
      const keep = keepRaw ? Number(keepRaw) : PGLITE_UPGRADE_BACKUP_RETENTION;
      if (keepRaw && !Number.isInteger(keep)) fail(json, 'invalid_keep', '--keep must be an integer.');
      const result = prunePgliteUpgradeBackups({
        backupRoot: resolveBackupRoot(args, cfg),
        databasePath: resolveDatabasePath(args, cfg),
        keep,
      });
      if (json) printJson(result);
      else {
        process.stdout.write(
          `已清理 PGLite 升级备份：保留 ${result.kept.length} 份，删除 ${result.deleted.length} 份（策略：最近 ${result.keep} 份）。\n`,
        );
        for (const directory of result.deleted) {
          process.stdout.write(`  已删除：${directory}\n`);
        }
      }
      return;
    }

    if (subcommand === 'delete') {
      const cfg = requirePgliteConfig(json);
      const backup = valueAfter(args, '--backup');
      if (!backup) fail(json, 'missing_backup', '--backup <backup-directory> is required.');
      const result = deletePgliteUpgradeBackup({
        backupDirectory: resolve(backup),
        backupRoot: resolveBackupRoot(args, cfg),
        databasePath: resolveDatabasePath(args, cfg),
      });
      if (json) printJson(result);
      else process.stdout.write(`已删除 PGLite 升级备份：${result.backupDirectory}\n当前数据库未被修改。\n`);
      return;
    }

    if (subcommand === 'restore') {
      const cfg = requirePgliteConfig(json);
      const backup = valueAfter(args, '--backup');
      if (!backup) fail(json, 'missing_backup', '--backup <backup-directory> is required.');
      if (!args.includes('--yes')) {
        fail(json, 'missing_yes', 'restore requires --yes because it replaces the active PGLite database.');
      }
      const result = await restorePgliteUpgradeBackup({
        backupDirectory: resolve(backup),
        backupRoot: resolveBackupRoot(args, cfg),
        databasePath: resolveDatabasePath(args, cfg),
      });
      if (json) printJson(result);
      else {
        process.stdout.write(
          `已用验证备份替换当前 PGLite 数据库。\n` +
          `  备份目录：${result.backupDirectory}\n` +
          `  当前数据库：${result.databasePath}\n` +
          '备份本身仍保留。启动桌面端或 sidecar 前请确认没有其他进程占用该目录。\n',
        );
      }
      return;
    }

    if (subcommand === 'set-root') {
      const cfg = requirePgliteConfig(json);
      const directory = valueAfter(args, '--dir')?.trim();
      if (!directory) fail(json, 'missing_dir', '--dir <backup-directory> is required.');
      const prepared = preparePgliteUpgradeBackupRoot({
        backupRoot: directory,
        databasePath: resolveDatabasePath(args, cfg),
      });
      const previous = resolvePgliteUpgradeBackupRoot(cfg.pglite_upgrade_backup_dir);
      const unchanged = previous === prepared.backupRoot && cfg.pglite_upgrade_backup_dir === prepared.backupRoot;
      if (!unchanged) {
        saveConfig({ ...cfg, pglite_upgrade_backup_dir: prepared.backupRoot });
      }
      const result = {
        status: unchanged ? 'unchanged' : prepared.status,
        backup_root: prepared.backupRoot,
      };
      if (json) printJson(result);
      else {
        process.stdout.write(
          `${unchanged ? '备份目录未变化' : '已更新 PGLite 升级备份目录'}：${prepared.backupRoot}\n` +
          '现有备份不会自动搬迁；之后的自动升级备份会写入此目录。\n',
        );
      }
      return;
    }

    fail(json, 'unknown_subcommand', `Unknown pglite-backup subcommand: ${subcommand}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(json, 'backup_failed', message);
  }
}
