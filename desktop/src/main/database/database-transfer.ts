import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getSetupInfo, restoreConfig, snapshotConfig, switchToProvisionedPostgres } from '../config-manager.js';
import { runCliChecked, type CliRuntime } from '../cli-runner.js';
import { DatabaseRuntimeManager } from '../database-runtime-manager.js';
import type { SidecarController } from '../sidecar/sidecar-controller.js';
import type { FullTransferPlan, FullTransferReceipt } from '../../../../src/commands/full-engine-transfer.ts';

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

  async preflight(): Promise<FullTransferPlan> {
    if (this.running) throw new Error('数据库迁移任务正在执行，请等待完成。');
    const setup = getSetupInfo();
    if (setup.needsSetup || setup.current.engine !== 'pglite' || !setup.current.databasePath) {
      throw new Error('请先完成 PGLite 初始配置，再扫描迁移方案。');
    }
    this.running = true;
    let stopped = false;
    try {
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在扫描迁移方案', message: '只读检查旧库表、行数、向量维度和历史结构。' });
      await this.dependencies.sidecar.stop();
      stopped = true;
      const result = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'migrate', '--to', 'postgres', '--full-copy', '--no-switch', '--preflight',
      ]);
      const plan = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as FullTransferPlan;
      if (!plan.fingerprint || !Array.isArray(plan.tables)) throw new Error('迁移预检未返回有效方案。');
      return plan;
    } finally {
      if (stopped) await this.dependencies.sidecar.start(false);
      this.dependencies.hideProgress();
      this.running = false;
    }
  }

  async migrate(planFingerprint: string, skipUnknown: boolean): Promise<{ backupDirectory: string; configBackup: string | null; containerName: string; volumeName: string; tables: number; rows: number; skippedTables: FullTransferReceipt['skippedTables']; reportPath: string }> {
    if (this.running) throw new Error('数据库迁移已在执行，请等待完成。');
    if (!/^[a-f0-9]{64}$/.test(planFingerprint)) throw new Error('请先扫描并确认迁移方案。');
    this.running = true;
    let stopped = false;
    let switched = false;
    let originalConfig: ReturnType<typeof snapshotConfig> | undefined;
    let containerName: string | undefined;
    let backupDirectory: string | undefined;
    let workingCopyRoot: string | undefined;
    try {
      const setup = getSetupInfo();
      originalConfig = snapshotConfig();
      if (setup.needsSetup || setup.current.engine !== 'pglite' || !setup.current.databasePath) {
        throw new Error('请先完成 PGLite 初始配置，再执行全库迁移。');
      }
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在复核迁移方案', message: '正在确认旧库与用户看到的预检方案一致。' });
      await this.dependencies.sidecar.stop();
      stopped = true;
      const preflightResult = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'migrate', '--to', 'postgres', '--full-copy', '--no-switch', '--preflight',
      ]);
      const currentPlan = JSON.parse(preflightResult.stdout.trim().split(/\r?\n/).at(-1) || '{}') as FullTransferPlan;
      if (currentPlan.fingerprint !== planFingerprint) throw new Error('旧库在预检后发生变化，请重新扫描迁移方案。');
      const unknownTables = currentPlan.tables.filter(table => table.action === 'unknown').map(table => table.name);
      if (unknownTables.length > 0 && !skipUnknown) throw new Error('发现未知旧表，请先选择跳过继续或取消迁移。');
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在建立 PGLite 冷备', message: '备份必须验证成功，原数据库不会被删除或修改。' });
      let backup: { status?: string; backup_directory?: string; backup_database_path?: string };
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
      backupDirectory = backup.backup_directory;
      const backupDatabasePath = backup.backup_database_path || join(backup.backup_directory, 'brain.pglite');
      if (!existsSync(backupDatabasePath)) throw new Error('无法定位已验证的 PGLite 冷备数据库，迁移已停止。');
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在准备只读迁移来源', message: '从冷备建立临时工作副本，原库和冷备本体保持不变。' });
      workingCopyRoot = mkdtempSync(join(dirname(backup.backup_directory), 'pmbrain-transfer-work-'));
      const workingDatabasePath = join(workingCopyRoot, 'brain.pglite');
      cpSync(backupDatabasePath, workingDatabasePath, { recursive: true });
      this.dependencies.sendProgress({ visible: true, stage: 'database', title: '正在准备 Docker Postgres', message: '正在启动 Docker、创建专属数据库与持久数据卷。' });
      const provisioned = await this.dependencies.databaseRuntime.provisionLocalPostgres();
      containerName = provisioned.containerName;
      this.dependencies.sendProgress({ visible: true, stage: 'migration', title: '正在复制并核对完整知识库', message: '正在迁移所有数据库表、知识、事实、关系及向量；完成前不会切换原库。' });
      let progressBuffer = '';
      const result = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'migrate', '--to', 'postgres', '--full-copy', '--no-switch',
      ], {
        PMBRAIN_MIGRATION_TARGET_URL: provisioned.databaseUrl,
        PMBRAIN_MIGRATION_SOURCE_BACKUP_PATH: workingDatabasePath,
        PMBRAIN_MIGRATION_PLAN_FINGERPRINT: planFingerprint,
        PMBRAIN_MIGRATION_SKIP_TABLES: JSON.stringify(unknownTables),
      }, chunk => {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('[pmbrain-transfer]')) continue;
          try {
            const item = JSON.parse(line.slice('[pmbrain-transfer]'.length)) as { category: string; completed?: number; total?: number; copied?: number; tableTotal?: number };
            const message = item.copied === undefined
              ? `${item.category}：已校验 ${item.completed}/${item.total} 张数据表。`
              : `${item.category}：正在复制 ${item.copied}/${item.tableTotal} 条记录。`;
            this.dependencies.sendProgress({ visible: true, stage: 'migration', title: '正在复制并核对完整知识库', message });
          } catch { continue; }
        }
      });
      const receipt = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as FullTransferReceipt;
      if (receipt.status !== 'verified' || !Array.isArray(receipt.tables) || receipt.tables.length === 0) {
        throw new Error('迁移未返回逐表校验结果，原数据库配置未切换。');
      }
      switched = true;
      const config = switchToProvisionedPostgres(provisioned.databaseUrl, provisioned.containerName);
      this.dependencies.sendProgress({ visible: true, stage: 'sidecar', title: '正在验证新数据库', message: '已复制并核对全部数据，正在启动 PMBrain 验证新连接。' });
      await this.dependencies.sidecar.start(false);
      if (this.dependencies.sidecar.state?.phase !== 'ready') throw new Error('新数据库连接健康检查未通过。');
      const reportPath = join(backup.backup_directory, 'docker-migration-report.json');
      writeFileSync(reportPath, JSON.stringify({
        status: 'verified', createdAt: new Date().toISOString(), sourceSchemaVersion: currentPlan.schemaVersion,
        sourceFingerprint: planFingerprint, backupDirectory: backup.backup_directory,
        containerName: provisioned.containerName, volumeName: provisioned.volumeName,
        plannedTables: currentPlan.tables, vectorColumns: currentPlan.vectors,
        copiedTables: receipt.tables, converted: receipt.converted ?? [], skippedTables: receipt.skippedTables ?? [],
        excludedOperationalTables: receipt.excludedOperationalTables,
        totalRows: receipt.tables.reduce((sum, table) => sum + table.rows, 0),
      }, null, 2));
      return {
        backupDirectory: backup.backup_directory,
        configBackup: config.backup,
        containerName: provisioned.containerName,
        volumeName: provisioned.volumeName,
        tables: receipt.tables.length,
        rows: receipt.tables.reduce((sum, table) => sum + table.rows, 0),
        skippedTables: receipt.skippedTables ?? [],
        reportPath,
      };
    } catch (error) {
      if (switched && originalConfig) restoreConfig(originalConfig);
      let failureReportPath: string | undefined;
      if (backupDirectory) {
        try {
          failureReportPath = join(backupDirectory, 'docker-migration-failure.json');
          writeFileSync(failureReportPath, JSON.stringify({
            status: 'failed', createdAt: new Date().toISOString(), sourceFingerprint: planFingerprint,
            backupDirectory, containerName: containerName ?? null,
            message: error instanceof Error ? error.message.slice(-4000) : String(error).slice(-4000),
          }, null, 2));
        } catch { failureReportPath = undefined; }
      }
      if (stopped) {
        try { await this.dependencies.sidecar.stop(); await this.dependencies.sidecar.start(false); }
        catch (restartError) {
          throw new Error(`迁移失败，已保留原 PGLite；恢复原服务也失败：${restartError instanceof Error ? restartError.message : String(restartError)}`, { cause: error });
        }
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const diagnostic = [...rawMessage.matchAll(/^error:\s*(.+)$/gm)].at(-1)?.[1];
      const message = diagnostic || (rawMessage.length > 1800 ? rawMessage.slice(-1800) : rawMessage);
      throw new Error(`${message}。原 PGLite 保留且未删除。${containerName ? `新容器 ${containerName} 已保留供排查。` : ''}${failureReportPath ? `失败报告：${failureReportPath}。` : ''}`, { cause: error });
    } finally {
      if (workingCopyRoot && backupDirectory && dirname(resolve(workingCopyRoot)) === resolve(dirname(backupDirectory)) && basename(workingCopyRoot).startsWith('pmbrain-transfer-work-')) {
        try { rmSync(workingCopyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
        catch (error) { console.error('迁移临时工作副本清理失败：', error); }
      }
      this.dependencies.hideProgress();
      this.running = false;
    }
  }
}
