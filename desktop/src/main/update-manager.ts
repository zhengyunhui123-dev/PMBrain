import type { DesktopLogger } from './logs.js';

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message: string;
}

interface UpdateInfo { version: string }
interface DownloadProgress { percent: number }

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): unknown;
  on(event: 'download-progress', listener: (progress: DownloadProgress) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdateManagerOptions {
  updater: UpdaterLike;
  packaged: boolean;
  currentVersion: string;
  logger: DesktopLogger;
  beforeInstall: () => Promise<void>;
  onState?: (state: UpdateState) => void;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class UpdateManager {
  private readonly options: UpdateManagerOptions;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private downloading = false;
  private state: UpdateState;

  constructor(options: UpdateManagerOptions) {
    this.options = options;
    this.state = options.packaged
      ? { phase: 'idle', currentVersion: options.currentVersion, message: '等待检查更新' }
      : { phase: 'disabled', currentVersion: options.currentVersion, message: '开发模式不检查更新' };
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    this.bindEvents();
  }

  get currentState(): UpdateState {
    return this.state;
  }

  start(): void {
    this.emit(this.state);
    if (!this.options.packaged) return;
    const initial = setTimeout(() => void this.check(), 5_000);
    initial.unref();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<UpdateState> {
    if (!this.options.packaged) return this.state;
    if (this.checking || this.downloading || this.state.phase === 'downloaded' || this.state.phase === 'installing') {
      return this.state;
    }
    this.checking = true;
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  async install(): Promise<void> {
    if (this.state.phase !== 'downloaded') throw new Error('更新包尚未下载完成。');
    this.emit({ ...this.state, phase: 'installing', message: '正在停止 PMBrain 并安装更新…' });
    await this.options.beforeInstall();
    this.options.updater.quitAndInstall(false, true);
  }

  private bindEvents(): void {
    const updater = this.options.updater;
    updater.on('checking-for-update', () => {
      this.emit({ phase: 'checking', currentVersion: this.options.currentVersion, message: '正在检查 GitHub Releases…' });
    });
    updater.on('update-not-available', () => {
      this.emit({ phase: 'up-to-date', currentVersion: this.options.currentVersion, message: '当前已经是最新版本' });
    });
    updater.on('update-available', (info) => {
      this.emit({
        phase: 'available', currentVersion: this.options.currentVersion,
        availableVersion: info.version, message: `发现新版本 ${info.version}，准备下载…`,
      });
      void this.download(info.version);
    });
    updater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      this.emit({ ...this.state, phase: 'downloading', percent, message: `正在下载更新 ${percent}%` });
    });
    updater.on('update-downloaded', (info) => {
      this.downloading = false;
      this.emit({
        phase: 'downloaded', currentVersion: this.options.currentVersion,
        availableVersion: info.version, percent: 100, message: `版本 ${info.version} 已下载，可以安装`,
      });
    });
    updater.on('error', (error) => this.handleError(error));
  }

  private async download(version: string): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;
    this.emit({
      phase: 'downloading', currentVersion: this.options.currentVersion,
      availableVersion: version, percent: 0, message: `正在下载版本 ${version}…`,
    });
    try {
      await this.options.updater.downloadUpdate();
    } catch (error) {
      this.downloading = false;
      this.handleError(error);
    }
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const displayMessage = `更新失败：${message}`;
    if (this.state.phase === 'error' && this.state.message === displayMessage) return;
    this.options.logger.write('updater', message);
    this.emit({
      phase: 'error', currentVersion: this.options.currentVersion,
      message: displayMessage,
    });
  }

  private emit(state: UpdateState): void {
    this.state = state;
    this.options.logger.write('updater', state.message);
    this.options.onState?.(state);
  }
}
