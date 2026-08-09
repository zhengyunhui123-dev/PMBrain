import { app } from 'electron';
import { getDatabaseRuntimeConfig, getSetupInfo, needsDesktopMigration, saveDetectedDockerContainerName } from '../config-manager.js';
import { runCliChecked, type CliRuntime } from '../cli-runner.js';
import type { DesktopLogger } from '../logs.js';
import { DatabaseRuntimeManager } from '../database-runtime-manager.js';
import type { PgliteBackupController } from './pglite-backup.js';

const DESKTOP_MIGRATION_ARGS = ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'];

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

export interface DatabaseUpgradeDependencies {
  runtime: () => CliRuntime;
  getLogger: () => DesktopLogger | null;
  pgliteBackup: PgliteBackupController;
  syncModelDefaults: () => Promise<void>;
  sendStartupProgress: (progress: StartupProgress) => void;
}

export class DatabaseUpgradeController {
  private readonly runtimeManager = new DatabaseRuntimeManager();

  constructor(private readonly dependencies: DatabaseUpgradeDependencies) {}

  async prepareConfiguredDatabase(): Promise<void> {
    const setup = getSetupInfo();
    if (setup.needsSetup || setup.current.engine === 'pglite') return;
    const database = getDatabaseRuntimeConfig();
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在准备本机数据库',
      message: '正在检查 Postgres；如现有 Docker Desktop 或数据库容器未启动，PMBrain 会安全启动它们，但不会创建、删除或重建容器。',
    });
    const result = await this.runtimeManager.ensureReady({
      engine: database.engine,
      databaseUrl: database.databaseUrl,
      configuredContainerName: database.configuredContainerName,
    });
    if (result.kind === 'docker-postgres') {
      saveDetectedDockerContainerName(result.containerName);
      this.dependencies.getLogger()?.write('desktop', `Docker Postgres ready: ${result.containerName}; started=${result.containerStarted}`);
    } else {
      this.dependencies.getLogger()?.write('desktop', `Postgres runtime ready: ${result.kind}`);
    }
  }

  async migrateConfiguredInstallation(): Promise<boolean> {
    if (!needsDesktopMigration(app.getVersion())) return false;
    const setup = getSetupInfo();
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '正在升级现有 PMBrain 数据库',
      message: setup.current.engine === 'pglite'
        ? '检测到桌面版本更新，将由唯一的 sidecar 连接完成 PGLite 兼容迁移和健康检查。'
        : '检测到桌面版本更新，正在执行兼容迁移。不会删除知识库或原始资料，请不要关闭窗口。',
    });
    if (setup.current.engine === 'pglite') {
      await this.dependencies.pgliteBackup.ensureUpgradeBackup(setup.current.databasePath);
      this.dependencies.getLogger()?.write('desktop', `PGLite migrations delegated to sidecar for desktop ${app.getVersion()}`);
      await this.dependencies.syncModelDefaults();
      return true;
    }
    this.dependencies.getLogger()?.write('desktop', `Applying migrations for desktop ${app.getVersion()}`);
    await runCliChecked(this.dependencies.runtime(), DESKTOP_MIGRATION_ARGS);
    await this.dependencies.syncModelDefaults();
    return true;
  }
}
