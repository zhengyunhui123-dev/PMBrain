import type { CliRuntime } from '../cli-runner.js';
import type { SetupInfo } from '../config-manager.js';
import type { DesktopPgliteUpgradeBackups } from '../../preload/index.js';

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

interface PgliteBackupListCliEntry {
  status?: string;
  backup_directory?: string;
  backup_database_path?: string;
  manifest_path?: string;
  created_at?: string;
  target_version?: string;
  source_schema_version?: number | null;
  recovery_verified_at?: string;
}

export interface PgliteBackupControllerDependencies {
  appVersion: () => string;
  setupInfo: () => SetupInfo;
  runtime: () => CliRuntime;
  runCliChecked: (runtime: CliRuntime, args: string[]) => Promise<{ stdout: string }>;
  sendStartupProgress: (progress: StartupProgress) => void;
  log: (message: string) => void;
}

export class PgliteBackupController {
  private readonly backupByVersion = new Map<string, string | null>();
  pendingBackupPath: string | null = null;

  constructor(private readonly dependencies: PgliteBackupControllerDependencies) {}

  async ensureUpgradeBackup(databasePath: string | null | undefined): Promise<string | null> {
    if (!databasePath) throw new Error('PGLite 升级前无法确定数据库路径，已停止迁移。');
    const pathKey = process.platform === 'win32' ? databasePath.toLowerCase() : databasePath;
    const key = `${pathKey}::${this.dependencies.appVersion()}`;
    if (this.backupByVersion.has(key)) {
      const cached = this.backupByVersion.get(key) ?? null;
      this.pendingBackupPath = cached;
      return cached;
    }

    this.pendingBackupPath = null;
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '正在创建升级前数据库冷备',
      message: 'sidecar 已停止。PMBrain 正在取得独占迁移锁、复制完整 PGLite 目录并验证恢复副本，请不要关闭窗口。',
    });
    const { parseSuccessfulBackupJsonFromError } = await import('../startup/post-upgrade-startup.js');
    let result: {
      status?: string;
      backup_directory?: string;
      reason?: string;
    };
    try {
      const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'pglite-backup',
        'create',
        '--path', databasePath,
        '--target-version', this.dependencies.appVersion(),
        '--json',
      ]);
      result = JSON.parse(completed.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
        status?: string;
        backup_directory?: string;
        reason?: string;
      };
    } catch (error) {
      // Windows occasionally exits non-zero after printing a valid success
      // envelope. Recover so upgrade first-boot is not false-failed.
      const recovered = parseSuccessfulBackupJsonFromError(
        error instanceof Error ? error.message : String(error),
      );
      if (!recovered) throw error;
      this.dependencies.log(
        `PGLite upgrade backup CLI exited non-zero but returned success JSON (${recovered.status}); continuing.`,
      );
      result = recovered;
    }
    if (result.status === 'not_required' && result.reason === 'database_missing') {
      this.backupByVersion.set(key, null);
      this.dependencies.log(`PGLite upgrade backup not required; database does not exist yet: ${databasePath}`);
      return null;
    }
    if (!['created', 'reused'].includes(result.status ?? '') || !result.backup_directory) {
      throw new Error('PGLite 升级冷备没有返回可验证的备份目录，已停止迁移。');
    }

    this.pendingBackupPath = result.backup_directory;
    this.backupByVersion.set(key, result.backup_directory);
    this.dependencies.log(`Verified PGLite pre-upgrade backup: ${result.backup_directory}`);
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '升级前冷备验证通过',
      message: `可恢复备份已保留：${result.backup_directory}。现在开始兼容迁移；失败时不会自动覆盖数据库。`,
    });
    return result.backup_directory;
  }

  async listUpgradeBackups(): Promise<DesktopPgliteUpgradeBackups> {
    const setup = this.dependencies.setupInfo();
    if (setup.needsSetup || setup.current.engine !== 'pglite') {
      return { databasePath: null, backups: [] };
    }
    const databasePath = setup.current.databasePath ?? setup.defaults.databasePath;
    const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
      'pglite-backup',
      'list',
      '--path', databasePath,
      '--json',
    ]);
    const result = JSON.parse(completed.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
      status?: string;
      database_path?: string;
      backups?: PgliteBackupListCliEntry[];
    };
    if (result.status !== 'ok' || !Array.isArray(result.backups)) {
      throw new Error('PGLite 备份清单返回格式无效，无法显示软件修复内容。');
    }
    const backups = result.backups.flatMap((entry) => {
      if (entry.status !== 'verified'
        || !entry.backup_directory
        || !entry.backup_database_path
        || !entry.manifest_path
        || !entry.created_at
        || !entry.target_version
        || !entry.recovery_verified_at) {
        return [];
      }
      return [{
        status: 'verified' as const,
        backupDirectory: entry.backup_directory,
        backupDatabasePath: entry.backup_database_path,
        manifestPath: entry.manifest_path,
        createdAt: entry.created_at,
        targetVersion: entry.target_version,
        sourceSchemaVersion: typeof entry.source_schema_version === 'number' ? entry.source_schema_version : null,
        recoveryVerifiedAt: entry.recovery_verified_at,
      }];
    });
    return {
      databasePath: result.database_path ?? databasePath,
      backups,
    };
  }
}
