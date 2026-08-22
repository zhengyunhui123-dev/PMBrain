import { app } from 'electron';
import { basename, resolve } from 'node:path';
import {
  getSetupInfo,
  markDesktopMigration,
  markMainSourcePathRepairCompleted,
  needsDesktopMigration,
  restoreConfig,
  saveSetup,
  updateSavedEmbeddingDimension,
  type DesktopTheme,
  type SetupPayload,
} from '../config-manager.js';
import { runCli, runCliChecked, type CliRuntime } from '../cli-runner.js';
import { listIntegrationsWithConnectionState } from '../integration-manager.js';
import type { PgliteBackupController } from '../database/pglite-backup.js';
import type { SidecarController } from '../sidecar/sidecar-controller.js';
import { ensureKnowledgeDirectory } from './knowledge-directory.js';
import {
  decideLegacyMainSourceRepair,
  decideSourceSetupPolicy,
  isSourcePathConflict,
  type SourceSetupPolicy,
} from './source-setup-policy.js';

const DESKTOP_MIGRATION_ARGS = ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'];

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

interface CanonicalMainSource {
  id: string;
  localPath?: string;
}

function sameSourcePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export interface SetupControllerDependencies {
  runtime: () => CliRuntime;
  sidecar: SidecarController;
  pgliteBackup: PgliteBackupController;
  ensureRuntimeReady: () => Promise<void>;
  prepareConfiguredDatabase: () => Promise<void>;
  syncModelDefaults: (options?: { resetAdvanced?: boolean }) => Promise<void>;
  sendStartupProgress: (progress: StartupProgress) => void;
  hideStartupProgress: () => void;
  applyTheme: (theme: DesktopTheme) => unknown;
}

export class SetupController {
  private applying = false;

  constructor(private readonly dependencies: SetupControllerDependencies) {}

  get inProgress(): boolean {
    return this.applying;
  }

  private async readCanonicalMainSource(): Promise<CanonicalMainSource | null> {
    const activeSidecar = this.dependencies.sidecar.current;
    if (!activeSidecar || this.dependencies.sidecar.state?.phase !== 'ready') return null;
    const overview = await activeSidecar.adminRequest<{
      main_source_id?: string;
      sources?: Array<{ id: string; local_path?: string | null; archived?: boolean }>;
    }>('/admin/api/brain/overview');
    const id = overview.main_source_id?.trim();
    if (!id) return null;
    const source = overview.sources?.find(candidate => candidate.id === id && candidate.archived !== true);
    return { id, ...(source?.local_path ? { localPath: source.local_path } : {}) };
  }

  private async repairMissingMainSourcePath(sourceId: string, localPath: string): Promise<void> {
    const activeSidecar = this.dependencies.sidecar.current;
    if (!activeSidecar || this.dependencies.sidecar.state?.phase !== 'ready') return;
    await activeSidecar.adminRequest('/admin/api/sources/local-path', {
      method: 'POST',
      body: JSON.stringify({ sourceId, localPath }),
    });
  }

  private sourceSetupPolicy(payload: SetupPayload): SourceSetupPolicy {
    const setup = getSetupInfo();
    return decideSourceSetupPolicy({
      firstSetup: setup.needsSetup,
      knowledgeSourceChanged: payload.knowledgeSourceChanged,
      storedKnowledgeDirectory: setup.current.knowledgeDirectory,
      storedKnowledgeSourceId: setup.current.knowledgeSourceId,
      requestedKnowledgeDirectory: payload.knowledgeDirectory,
      requestedKnowledgeSourceId: payload.knowledgeSourceId,
    });
  }

  private async markMainSourcePathRepairComplete(): Promise<void> {
    try {
      markMainSourcePathRepairCompleted();
    } catch (error) {
      // The marker prevents repeated compatibility work, but failure to write
      // it must not make an otherwise usable PMBrain installation fail.
      console.warn(
        '[desktop] Unable to persist main source path repair marker:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async repairLegacyMainSourcePath(): Promise<void> {
    const setup = getSetupInfo();
    const canonical = await this.readCanonicalMainSource().catch(() => null);
    const action = decideLegacyMainSourceRepair({
      firstSetup: setup.needsSetup,
      repairCompleted: setup.current.mainSourcePathRepairCompleted === true,
      mainSourceExists: canonical !== null,
      mainSourceId: canonical?.id,
      configuredMainSourceId: setup.current.knowledgeSourceId,
      mainSourceHasPath: Boolean(canonical?.localPath),
      knowledgeDirectory: setup.current.knowledgeDirectory,
    });
    if (action === 'skip') return;
    if (action === 'mark-complete') {
      await this.markMainSourcePathRepairComplete();
      return;
    }

    const knowledgeDirectory = setup.current.knowledgeDirectory?.trim();
    if (!canonical || !knowledgeDirectory) return;
    try {
      await this.repairMissingMainSourcePath(canonical.id, knowledgeDirectory);
    } catch (error) {
      if (!isSourcePathConflict(error)) {
        console.warn(
          '[desktop] Main source local_path compatibility repair deferred:',
          error instanceof Error ? error.message : error,
        );
        return;
      }
      console.warn(
        '[desktop] Main source local_path compatibility repair skipped because the configured '
          + 'knowledge directory overlaps another source:',
        error instanceof Error ? error.message : error,
      );
    }
    // A successful repair and a conflict skip both complete this historical
    // compatibility check. Explicit source changes are handled separately.
    await this.markMainSourcePathRepairComplete();
  }

  private async verifyConfiguredMainSource(sourceId: string, localPath: string): Promise<void> {
    const canonical = await this.readCanonicalMainSource().catch(() => null);
    if (canonical?.id === sourceId && canonical.localPath && sameSourcePath(canonical.localPath, localPath)) return;
    throw new Error(
      `主源路径校验失败：桌面目录为「${localPath}」，数据库主源「${canonical?.id ?? sourceId}」路径为「${canonical?.localPath ?? '空'}」。`
        + '未显示主源已配置成功，请检查后重试。',
    );
  }

  async currentState() {
    const setup = getSetupInfo();
    if (!setup.needsSetup) {
      await this.repairLegacyMainSourcePath();
      const canonical = await this.readCanonicalMainSource().catch(() => null);
      if (canonical) {
        setup.current.knowledgeSourceId = canonical.id;
        if (canonical.localPath) setup.current.knowledgeDirectory = canonical.localPath;
      }
    }
    return {
      setup,
      integrations: await listIntegrationsWithConnectionState(this.dependencies.sidecar.current?.port),
      port: this.dependencies.sidecar.current?.port,
      mcpUrl: this.dependencies.sidecar.current?.mcpUrl,
    };
  }

  async apply(payload: SetupPayload) {
    if (this.applying) throw new Error('PMBrain 正在应用上一份基础配置，请等待完成。');
    this.applying = true;
    try {
      const sourcePolicy = this.sourceSetupPolicy(payload);
      if (!sourcePolicy.explicitSourceChange) await this.repairLegacyMainSourcePath();
      const canonical = !sourcePolicy.explicitSourceChange
        ? await this.readCanonicalMainSource().catch(() => null)
        : null;
      const effectivePayload = canonical
        ? {
            ...payload,
            knowledgeSourceId: canonical.id,
            knowledgeDirectory: canonical.localPath ?? payload.knowledgeDirectory,
          }
        : payload;
      return await this.applyOnce(effectivePayload, sourcePolicy);
    } finally {
      this.applying = false;
    }
  }

  private async applyOnce(payload: SetupPayload, sourcePolicy: SourceSetupPolicy) {
    await this.dependencies.ensureRuntimeReady();
    const setupBeforeSave = getSetupInfo();
    const previousEmbeddingModel = setupBeforeSave.current.embeddingModel?.trim();
    const requestedEmbeddingModel = payload.modelConfig?.embeddingModel?.trim();
    const recoveryCandidate = setupBeforeSave.current.legacyEmbeddingRecoveryCandidate;
    const legacyEmbeddingRecoveryConfirmed = Boolean(
      payload.confirmLegacyEmbeddingRecovery === true
      && requestedEmbeddingModel
      && recoveryCandidate?.model === requestedEmbeddingModel,
    );
    if (previousEmbeddingModel
        && requestedEmbeddingModel
        && previousEmbeddingModel !== requestedEmbeddingModel
        && payload.confirmEmbeddingRebuild !== true
        && !legacyEmbeddingRecoveryConfirmed) {
      throw new Error(
        `向量模型将从 ${previousEmbeddingModel} 更换为 ${requestedEmbeddingModel}。`
        + '必须在桌面端明确确认重新向量化后才能继续。',
      );
    }
    const hadRunningSidecar = Boolean(this.dependencies.sidecar.current);
    await this.dependencies.sidecar.stop();
    let saved: ReturnType<typeof saveSetup>;
    let embeddingSwitchCommitted = false;
    let embeddingRebuildQueued = false;
    let reembeddingWarning: string | null = null;
    let migrationRequired = false;
    try {
      saved = saveSetup(payload);
    } catch (error) {
      if (hadRunningSidecar) await this.dependencies.sidecar.start(false).catch(() => undefined);
      else this.dependencies.hideStartupProgress();
      throw error;
    }
    try {
      await this.dependencies.prepareConfiguredDatabase();
      migrationRequired = needsDesktopMigration(app.getVersion());
      if (migrationRequired && saved.config.engine === 'pglite') {
        await this.dependencies.pgliteBackup.ensureUpgradeBackup(saved.config.database_path);
      }
      if (saved.needsEmbeddingDimensionProbe || saved.embeddingModelChanged) {
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'migration',
          title: '正在验证向量模型',
          message: '正在检查模型连接并确认向量维度。此步骤不会修改知识库内容。',
        });
        let probe: Awaited<ReturnType<typeof runCliChecked>>;
        try {
          probe = await runCliChecked(this.dependencies.runtime(), [
            'models',
            'detect-embedding-dimension',
            '--json',
            `--requested-dimensions=${saved.config.embedding_dimensions}`,
          ]);
        } catch (error) {
          if (saved.config.embedding_model?.startsWith('custom-openai:')) {
            const baseUrl = saved.config.provider_touchpoint_base_urls?.['custom-openai']?.embedding
              ?? saved.config.provider_base_urls?.['custom-openai']
              ?? '自定义 Base URL';
            const model = saved.config.embedding_model.slice('custom-openai:'.length);
            throw new Error(
              `自定义向量模型验证失败：无法通过 ${baseUrl} 访问模型 ${model}。`
              + '请确认本地模型服务已启动、Base URL 包含正确的 /v1 路径、模型 ID 与 API Key 正确。',
              { cause: error },
            );
          }
          throw error;
        }
        const result = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1) || '{}') as { dimensions?: number };
        if (!Number.isInteger(result.dimensions) || (result.dimensions ?? 0) <= 0) {
          throw new Error('无法从向量模型响应中判断有效维度。');
        }
        if (saved.config.embedding_dimensions !== result.dimensions) {
          updateSavedEmbeddingDimension(saved.snapshot.path, result.dimensions!);
          saved.config.embedding_dimensions = result.dimensions!;
        }
      }
      if (migrationRequired && saved.config.engine !== 'pglite') {
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'migration',
          title: '正在升级数据库',
          message: '检测到桌面版本更新，正在执行兼容升级。知识库与原始资料不会被删除。',
        });
        await runCliChecked(this.dependencies.runtime(), DESKTOP_MIGRATION_ARGS);
      }
      this.dependencies.sendStartupProgress({
        visible: true,
        stage: 'migration',
        title: '正在保存模型配置',
        message: '正在应用普通模型与向量模型设置。',
      });
      await this.dependencies.syncModelDefaults({ resetAdvanced: payload.resetAdvancedModelRouting === true });
      const knowledgeDirectory = saved.config.desktop?.knowledge_directory?.trim();
      const sourceId = saved.config.desktop?.knowledge_source_id?.trim();
      if (sourcePolicy.applySourceConfiguration && sourceId) {
        if (sourcePolicy.bindPath && knowledgeDirectory) {
          await ensureKnowledgeDirectory(knowledgeDirectory);
          await runCliChecked(this.dependencies.runtime(), [
            'sources', 'add', sourceId, '--path', knowledgeDirectory,
            '--name', basename(knowledgeDirectory), '--federated',
          ]);
        }
        await runCliChecked(this.dependencies.runtime(), ['sources', 'default', sourceId]);
      }
      if (migrationRequired && saved.config.engine !== 'pglite') markDesktopMigration(app.getVersion());
      if (saved.embeddingModelActivated) {
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'migration',
          title: '正在准备搜索索引',
          message: '正在按首次配置的向量模型对齐空向量库；知识页面、文本分块和原始资料不会被修改。',
        });
        await runCliChecked(this.dependencies.runtime(), [
          'models', 'align-embedding-dimension', '--yes', '--json', '--empty-only',
        ]);
        embeddingSwitchCommitted = true;
      } else if (saved.embeddingModelChanged && legacyEmbeddingRecoveryConfirmed) {
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'migration',
          title: '正在安全恢复原向量配置',
          message: '正在核对数据库实际维度并校正历史误标；不会清空或重新生成已有向量。',
        });
        await runCliChecked(this.dependencies.runtime(), [
          'models', 'restore-legacy-embedding-config', '--json',
        ]);
        embeddingSwitchCommitted = true;
      } else if (saved.embeddingModelChanged && !legacyEmbeddingRecoveryConfirmed) {
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'migration',
          title: '正在准备搜索索引',
          message: '你已确认更换向量模型，正在对齐维度并准备重新生成向量。',
        });
        await runCliChecked(this.dependencies.runtime(), [
          'models', 'align-embedding-dimension', '--yes', '--json', '--force-reembed',
        ]);
        embeddingSwitchCommitted = true;
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'migration',
          title: '正在准备后台向量重建',
          message: '新模型已生效，正在恢复本地服务；恢复后会由任务中心安全接管剩余向量化。Dream 不会自行触发模型迁移。',
        });
        embeddingRebuildQueued = true;
      }
    } catch (error) {
      if (!embeddingSwitchCommitted) restoreConfig(saved.snapshot);
      if (hadRunningSidecar && saved.snapshot.existed) {
        await this.dependencies.sidecar.start(false).catch(() => undefined);
      } else {
        this.dependencies.hideStartupProgress();
      }
      throw error;
    }
    await this.dependencies.sidecar.start(false);
    const savedKnowledgeDirectory = saved.config.desktop?.knowledge_directory;
    const savedSourceId = saved.config.desktop?.knowledge_source_id;
    if (sourcePolicy.bindPath && savedKnowledgeDirectory && savedSourceId) {
      await this.verifyConfiguredMainSource(savedSourceId, savedKnowledgeDirectory);
    }
    if (sourcePolicy.applySourceConfiguration) await this.markMainSourcePathRepairComplete();
    if (migrationRequired && saved.config.engine === 'pglite') {
      if (!this.dependencies.sidecar.current || this.dependencies.sidecar.state?.phase !== 'ready') {
        throw new Error('PGLite sidecar 尚未完成数据库迁移和健康检查。');
      }
      markDesktopMigration(app.getVersion());
    }
    this.dependencies.applyTheme(getSetupInfo().current.theme);
    // Read all sidecar-backed setup state before submitting the background
    // task. The task coordinator will briefly disconnect PGLite before its
    // CLI child starts; no post-submit database request may race that handoff.
    const integrations = await listIntegrationsWithConnectionState(this.dependencies.sidecar.current?.port);
    if (embeddingRebuildQueued) {
      const activeSidecar = this.dependencies.sidecar.current;
      if (!activeSidecar || this.dependencies.sidecar.state?.phase !== 'ready') {
        reembeddingWarning = '新模型已生效，但本地服务尚未就绪，无法提交后台向量重建任务；请稍后在任务中心运行“补齐待向量化内容”。';
      } else {
        try {
          await activeSidecar.adminRequest('/admin/api/runs/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'embed_stale', catchUp: true }),
          });
        } catch (error) {
          reembeddingWarning = '新模型已生效，但后台向量重建任务提交失败；请稍后在任务中心运行“补齐待向量化内容”。'
            + ` 原因：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    return {
      setup: getSetupInfo(),
      integrations,
      port: this.dependencies.sidecar.current?.port,
      mcpUrl: this.dependencies.sidecar.current?.mcpUrl,
      backup: saved.backup,
      reembeddingWarning,
    };
  }
}
