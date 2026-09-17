import { randomUUID } from 'node:crypto';
import { getSetupInfo, restoreConfig, snapshotConfig, switchToProvisionedPostgres } from '../config-manager.js';
import { runCliChecked, type CliRuntime } from '../cli-runner.js';
import { DatabaseRuntimeManager } from '../database-runtime-manager.js';
import type { SidecarController } from '../sidecar/sidecar-controller.js';

interface TransferProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

export interface DatabaseTransferDependencies {
  runtime: () => CliRuntime;
  sidecar: Pick<SidecarController, 'stop' | 'start' | 'state'>;
  databaseRuntime: Pick<DatabaseRuntimeManager, 'provisionLocalPostgres'>;
  runCliChecked: typeof runCliChecked;
  sendProgress: (progress: TransferProgress) => void;
  hideProgress: () => void;
}

export class DatabaseTransferController {
  private running = false;

  constructor(private readonly dependencies: DatabaseTransferDependencies) {}

  get inProgress(): boolean { return this.running; }

  async migrate(): Promise<{ backupDirectory: string; configBackup: string | null; containerName: string; volumeName: string; tables: number; rows: number }> {
    if (this.running) throw new Error('数据库迁移已在执行，请等待完成。');
    this.running = true;
    let stopped = false;
    let switched = false;
    let originalConfig: ReturnType<typeof snapshotConfig> | undefined;
    let containerName: string | undefined;
    try {
      const setup = getSetupInfo();
      originalConfig = snapshotConfig();
      if (setup.needsSetup || setup.current.engine !== 'pglite' || !setup.current.databasePath) {
        throw new Error('请先完成 PGLite 初始配置，再执行全库迁移。');
      }
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在迁移完整知识库', message: '正在停止本地服务并创建完整 PGLite 冷备。' });
      await this.dependencies.sidecar.stop();
      stopped = true;
      let backup: { status?: string; backup_directory?: string };
      try {
        const backupResult = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
          'pglite-backup', 'create', '--path', setup.current.databasePath,
          '--target-version', `docker-transfer-${randomUUID()}`, '--json',
        ]);
        backup = JSON.parse(backupResult.stdout.trim().split(/\r?\n/).at(-1) || '{}') as typeof backup;
      } catch (error) {
        const { parseSuccessfulBackupJsonFromError } = await import('../startup/post-upgrade-startup.js');
        const recovered = parseSuccessfulBackupJsonFromError(error instanceof Error ? error.message : String(error));
        if (!recovered) throw error;
        backup = recovered;
      }
      if (backup.status !== 'created' || !backup.backup_directory) throw new Error('PGLite 冷备未验证成功，迁移已停止。');
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在准备 Docker Postgres', message: '正在启动 Docker、创建专属数据库与持久数据卷。' });
      const provisioned = await this.dependencies.databaseRuntime.provisionLocalPostgres();
      containerName = provisioned.containerName;
      this.dependencies.sendProgress({ visible: true, stage: 'migration', title: '正在复制并核对完整知识库', message: '正在迁移所有数据库表、知识、事实、关系及向量；完成前不会切换原库。' });
      const result = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'migrate', '--to', 'postgres', '--full-copy', '--no-switch',
      ], { PMBRAIN_MIGRATION_TARGET_URL: provisioned.databaseUrl });
      const receipt = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
        status?: string;
        tables?: Array<{ name: string; rows: number; sha256: string }>;
      };
      if (receipt.status !== 'verified' || !Array.isArray(receipt.tables) || receipt.tables.length === 0) {
        throw new Error('迁移未返回逐表校验结果，原数据库配置未切换。');
      }
      switched = true;
      const config = switchToProvisionedPostgres(provisioned.databaseUrl, provisioned.containerName);
      this.dependencies.sendProgress({ visible: true, stage: 'sidecar', title: '正在验证新数据库', message: '已复制并核对全部数据，正在启动 PMBrain 验证新连接。' });
      await this.dependencies.sidecar.start(false);
      if (this.dependencies.sidecar.state?.phase !== 'ready') throw new Error('新数据库连接健康检查未通过。');
      return {
        backupDirectory: backup.backup_directory,
        configBackup: config.backup,
        containerName: provisioned.containerName,
        volumeName: provisioned.volumeName,
        tables: receipt.tables.length,
        rows: receipt.tables.reduce((sum, table) => sum + table.rows, 0),
      };
    } catch (error) {
      if (switched && originalConfig) restoreConfig(originalConfig);
      if (stopped) {
        try { await this.dependencies.sidecar.stop(); await this.dependencies.sidecar.start(false); }
        catch (restartError) {
          throw new Error(`迁移失败，已保留原 PGLite；恢复原服务也失败：${restartError instanceof Error ? restartError.message : String(restartError)}`, { cause: error });
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}。原 PGLite 保留且未删除。${containerName ? `新容器 ${containerName} 已保留供排查。` : ''}`, { cause: error });
    } finally {
      this.dependencies.hideProgress();
      this.running = false;
    }
  }
}
