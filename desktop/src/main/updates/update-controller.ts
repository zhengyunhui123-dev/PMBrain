import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopLogger } from '../logs.js';
import { UpdateManager, type UpdateState } from '../update-manager.js';

export interface UpdateControllerDependencies {
  getMainWindow: () => BrowserWindow | null;
  getLogger: () => DesktopLogger | null;
  openUpdatesPanel: () => Promise<void>;
  stopSidecar: () => Promise<void>;
  setQuitting: () => void;
}

export class UpdateController {
  private manager: UpdateManager | null = null;

  constructor(private readonly dependencies: UpdateControllerDependencies) {}

  get currentState(): UpdateState | null {
    return this.manager?.currentState ?? null;
  }

  initialize(): void {
    const logger = this.dependencies.getLogger();
    if (!logger) return;
    this.manager = new UpdateManager({
      updater: autoUpdater,
      packaged: app.isPackaged,
      currentVersion: app.getVersion(),
      currentReleaseNotes: this.readCurrentReleaseNotes(),
      logger,
      beforeInstall: async () => {
        this.manager?.stop();
        await this.dependencies.stopSidecar();
        logger.write('updater', 'Sidecar stopped; handing control to NSIS updater.');
        this.dependencies.setQuitting();
        logger.close();
      },
      onState: state => {
        this.dependencies.getMainWindow()?.webContents.send('desktop:update-state', state);
        if (state.phase === 'downloaded') void this.promptInstall(state);
      },
    });
    this.manager.start();
  }

  stop(): void {
    this.manager?.stop();
  }

  async open(): Promise<void> {
    await this.dependencies.openUpdatesPanel();
    await this.manager?.check();
  }

  check(): Promise<unknown> | undefined {
    return this.manager?.check();
  }

  download(): Promise<unknown> | undefined {
    return this.manager?.download();
  }

  install(): Promise<unknown> | undefined {
    return this.manager?.install();
  }

  private readCurrentReleaseNotes(): string | undefined {
    const releaseNotesPath = app.isPackaged
      ? join(process.resourcesPath, 'release-notes.md')
      : join(app.getAppPath(), 'build', 'release-notes.md');
    try {
      if (!existsSync(releaseNotesPath)) {
        this.dependencies.getLogger()?.write('updater', `Current release notes file not found: ${releaseNotesPath}`);
        return undefined;
      }
      const content = readFileSync(releaseNotesPath, 'utf8').trim();
      return content || undefined;
    } catch (error) {
      this.dependencies.getLogger()?.write(
        'updater',
        `Unable to read current release notes: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private async promptInstall(state: UpdateState): Promise<void> {
    const mainWindow = this.dependencies.getMainWindow();
    if (!mainWindow) return;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'PMBrain 更新已就绪',
      message: `版本 ${state.availableVersion ?? ''} 已下载完成`,
      detail: `${state.fileName ? `安装文件：${state.fileName}\n` : ''}立即安装会先安全停止 PMBrain 本地服务，安装完成后自动重新启动、执行数据库迁移并检查健康状态。`,
      buttons: ['立即安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) await this.manager?.install();
  }
}
