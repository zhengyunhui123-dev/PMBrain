import { app, dialog, nativeTheme, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAdvancedModelConfig, writeAdvancedModelConfig } from './advanced-model-config.js';
import { installAppMenu, type SettingsPanel } from './app/menu-controller.js';
import { showDesktopNotification as showNotification } from './app/desktop-notifications.js';
import { TrayController } from './app/tray-controller.js';
import { WindowController } from './app/window-controller.js';
import { runCliChecked, preflightCliRuntime, type CliRuntime } from './cli-runner.js';
import {
  getDesktopPreferences,
  getSetupInfo,
  saveDesktopPreferences,
} from './config-manager.js';
import { DatabaseUpgradeController } from './database/database-upgrade.js';
import { PgliteBackupController } from './database/pglite-backup.js';
import { buildDiagnosticBundle } from './diagnostics/diagnostic-bundle.js';
import { SharedAccessController } from './integration/shared-access-controller.js';
import { writeWorkbuddyUserAgent } from './integration/user-agent-writer.js';
import { WorkBuddyAgentController } from './integration/workbuddy-agent-controller.js';
import { registerDesktopIpcHandlers } from './ipc-handlers.js';
import {
  inspectDesktopPgliteRecovery,
  terminateDesktopPgliteOwnerAndRetry,
  type DesktopPgliteRecoveryDependencies,
} from './pglite-recovery.js';
import {
  initializeKnowledgeSourceGit,
  inspectKnowledgeSourceDirectory,
} from './knowledge-source-git.js';
import { DesktopLogger } from './logs.js';
import { syncModelDefaultsToConfigFile } from './models/model-config-sync.js';
import { testModelConnection } from './model-connection-test.js';
import { listDesktopProviderModels } from './model-catalog.js';
import { LanController } from './network/lan-controller.js';
import { listNetworkCandidates } from './network-manager.js';
import { SidecarController } from './sidecar/sidecar-controller.js';
import { SetupController } from './startup/setup-controller.js';
import { SystemSettingsController } from './system/system-settings-controller.js';
import { UpdateController } from './updates/update-controller.js';
import { updateDesktopVersionHistory, type DesktopVersionHistory } from './version-history.js';
import { isTrustedDesktopShellUrl } from './window-security.js';

let logger: DesktopLogger | null = null;
let runtimePreflightPromise: Promise<void> | null = null;
let desktopVersionHistory: DesktopVersionHistory = { current: '' };
let quitting = false;

const LAN_MONITOR_INTERVAL_MS = 5_000;
const DESKTOP_RENDERER_PATH = join(__dirname, '../renderer/index.html');

// Release E2E launches the previous installer with a CLI debugging flag, but
// electron-updater restarts the newly installed executable without preserving
// CLI arguments. This explicit test-only environment variable lets the new
// process reopen the same CDP port so the runner can verify the post-upgrade UI
// and database. Normal installs never set it.
const e2eRemoteDebuggingPort = process.env.PMBRAIN_E2E_REMOTE_DEBUGGING_PORT?.trim();
const e2eRemoteDebuggingPortNumber = Number(e2eRemoteDebuggingPort);
if (Number.isInteger(e2eRemoteDebuggingPortNumber)
  && e2eRemoteDebuggingPortNumber > 0
  && e2eRemoteDebuggingPortNumber <= 65_535) {
  app.commandLine.appendSwitch('remote-debugging-port', String(e2eRemoteDebuggingPortNumber));
}

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
  canDeferEmbeddingRebuild?: boolean;
  embeddingRebuildTotal?: number;
}

let startupProgress: StartupProgress = {
  visible: false,
  stage: 'sidecar',
  title: '',
  message: '',
};

function runtime(): CliRuntime {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  };
}

function sendStartupProgress(progress: StartupProgress): void {
  startupProgress = progress;
  windowController.current?.webContents.send('desktop:startup-progress', progress);
}

function hideStartupProgress(): void {
  sendStartupProgress({ ...startupProgress, visible: false, canDeferEmbeddingRebuild: false });
}

let embeddingRebuildChoiceResolver: ((choice: 'wait' | 'defer') => void) | null = null;

function waitEmbeddingRebuildChoice(): Promise<'wait' | 'defer'> {
  return new Promise(resolve => {
    embeddingRebuildChoiceResolver = resolve;
  });
}

function chooseEmbeddingRebuild(choice: 'wait' | 'defer'): void {
  const resolve = embeddingRebuildChoiceResolver;
  embeddingRebuildChoiceResolver = null;
  if (choice !== 'wait' && choice !== 'defer') return;
  resolve?.(choice);
}

async function ensureRuntimeReady(): Promise<void> {
  if (!app.isPackaged) return;
  if (runtimePreflightPromise) return runtimePreflightPromise;
  const pending = preflightCliRuntime(runtime()).then(result => {
    if (!result) return;
    logger?.write(
      'runtime',
      `Verified ${result.arch}-${result.flavor} Bun ${result.bunRevision} on Windows ${result.windowsRelease}`,
    );
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.write('runtime', `Runtime preflight failed: ${message}`);
    throw error;
  });
  runtimePreflightPromise = pending;
  try {
    await pending;
  } catch (error) {
    if (runtimePreflightPromise === pending) runtimePreflightPromise = null;
    throw error;
  }
}

const pgliteBackupController = new PgliteBackupController({
  appVersion: () => app.getVersion(),
  setupInfo: getSetupInfo,
  runtime,
  runCliChecked,
  sendStartupProgress,
  log: message => logger?.write('desktop', message),
});

const databaseUpgradeController = new DatabaseUpgradeController({
  runtime,
  getLogger: () => logger,
  pgliteBackup: pgliteBackupController,
  syncModelDefaults: () => syncModelDefaultsToConfigFile(runtime()),
  sendStartupProgress,
});

const lanController: LanController = new LanController({
  getPreferences: getDesktopPreferences,
  savePreferences: updates => saveDesktopPreferences(updates),
  listCandidates: listNetworkCandidates,
  getSidecar: () => sidecarController.current,
  getSidecarState: () => sidecarController.state,
  sendSystemSettingsState: () => { systemSettingsController.sendState(); },
  showNotification,
  getLogger: () => logger,
});

const sidecarController: SidecarController = new SidecarController({
  runtime,
  getLogger: () => logger,
  getMainWindow: () => windowController.current,
  getSetupInProgress: () => setupController.inProgress,
  ensureRuntimeReady,
  prepareConfiguredDatabase: () => databaseUpgradeController.prepareConfiguredDatabase(),
  migrateConfiguredInstallation: () => databaseUpgradeController.migrateConfiguredInstallation(),
  reconcileConfiguredEmbeddingIndex: () => databaseUpgradeController.reconcileConfiguredEmbeddingIndex(),
  pendingPgliteBackupPath: () => pgliteBackupController.pendingBackupPath,
  prunePgliteUpgradeBackups: () => pgliteBackupController.pruneUpgradeBackupsAfterUpgrade(),
  reconcileLan: () => lanController.reconcile(),
  stopLan: () => lanController.stop(),
  sendSystemSettingsState: () => { systemSettingsController.sendState(); },
  sendStartupProgress,
  hideStartupProgress,
});

const sharedAccessController = new SharedAccessController(sidecarController, lanController);
const workBuddyAgentController = new WorkBuddyAgentController({
  sidecar: sidecarController,
  configureMcp: () => sharedAccessController.configure('workbuddy', 'api_key'),
});

const systemSettingsController: SystemSettingsController = new SystemSettingsController({
  lan: lanController,
  sidecar: sidecarController,
  getMainWindow: () => windowController.current,
  refreshTray: () => trayController.refresh(),
});

const setupController: SetupController = new SetupController({
  runtime,
  sidecar: sidecarController,
  pgliteBackup: pgliteBackupController,
  ensureRuntimeReady,
  prepareConfiguredDatabase: () => databaseUpgradeController.prepareConfiguredDatabase(),
  syncModelDefaults: options => syncModelDefaultsToConfigFile(runtime(), options),
  sendStartupProgress,
  hideStartupProgress,
  waitEmbeddingRebuildChoice,
  applyTheme: theme => systemSettingsController.applyTheme(theme),
});

const windowController: WindowController = new WindowController({
  rendererPath: DESKTOP_RENDERER_PATH,
  preloadPath: join(__dirname, '../preload/index.cjs'),
  getRendererUrl: () => process.env.ELECTRON_RENDERER_URL,
  getQuitting: () => quitting,
  getLogger: () => logger,
  sidecar: sidecarController,
  hideStartupProgress,
  showNotification,
});

const updateController = new UpdateController({
  getMainWindow: () => windowController.current,
  getLogger: () => logger,
  openUpdatesPanel: () => openSettingsPanel('updates'),
  stopSidecar: () => sidecarController.stop(),
  setQuitting: () => { quitting = true; },
});

const trayController = new TrayController({
  getPreferences: getDesktopPreferences,
  getLanStatus: () => lanController.status,
  openDesktop: () => void openSettingsPanel('basic').catch(error => reportUiActionError('无法打开桌面设置', error)),
  openAdmin,
  openSystemSettings: () => openSettingsPanel('system'),
  reportError: reportUiActionError,
  quit: () => app.quit(),
});

function reportUiActionError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger?.write('desktop', `${title}: ${message}`);
  showNotification(title, message);
  windowController.reveal();
}

async function readReleaseManifest(): Promise<unknown> {
  const candidates = [
    join(app.getAppPath(), 'release-manifest.json'),
    join(app.getAppPath(), '..', 'release-manifest.json'),
    join(process.resourcesPath, 'release-manifest.json'),
  ];
  for (const path of candidates) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { /* try next packaged/dev location */ }
  }
  return null;
}

async function exportDiagnosticBundle(): Promise<{ path: string; fileName: string; files: string[] } | null> {
  const setup = getSetupInfo();
  const activeSidecar = sidecarController.current;
  const [doctor, overview, dreamStatus, releaseManifest] = await Promise.all([
    activeSidecar?.adminRequest('/admin/api/doctor').catch(error => ({
      status: 'unavailable', error: error instanceof Error ? error.message : String(error),
    })) ?? Promise.resolve({ status: 'sidecar_not_ready' }),
    activeSidecar?.adminRequest('/admin/api/brain/overview').catch(error => ({
      status: 'unavailable', error: error instanceof Error ? error.message : String(error),
    })) ?? Promise.resolve({ status: 'sidecar_not_ready' }),
    activeSidecar?.adminRequest('/admin/api/dream/overview').catch(error => ({
      status: 'unavailable', error: error instanceof Error ? error.message : String(error),
    })) ?? Promise.resolve({ status: 'sidecar_not_ready' }),
    readReleaseManifest(),
  ]);
  const bundle = await buildDiagnosticBundle({
    desktopVersion: app.getVersion(),
    releaseManifest,
    setup,
    sidecarState: sidecarController.state,
    updateState: updateController.currentState,
    logPath: logger?.filePath,
    doctor,
    overview,
    dreamStatus,
    personalPaths: [app.getPath('home'), app.getPath('userData')],
  });
  const mainWindow = windowController.current;
  if (!mainWindow) throw new Error('PMBrain desktop window is not ready.');
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PMBrain 诊断包',
    defaultPath: join(app.getPath('documents'), bundle.fileName),
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (selected.canceled || !selected.filePath) return null;
  await writeFile(selected.filePath, bundle.data, { flag: 'w' });
  await shell.showItemInFolder(selected.filePath);
  logger?.write('desktop', `Diagnostic bundle exported: ${selected.filePath}`);
  return { path: selected.filePath, fileName: bundle.fileName, files: bundle.files };
}

async function openSettingsPanel(panel: SettingsPanel): Promise<void> {
  await windowController.showShell();
  windowController.current?.webContents.send('desktop:show-panel', panel);
  windowController.reveal();
}

async function openAdmin(): Promise<void> {
  const mainWindow = windowController.current;
  if (!mainWindow) return;
  if (getSetupInfo().needsSetup) {
    await openSettingsPanel('basic');
    showNotification('请先完成基础配置', '数据库与模型配置完成后才能打开管理控制台。');
    return;
  }
  if (setupController.inProgress) {
    windowController.reveal();
    showNotification('PMBrain 正在完成配置', '请等待当前配置与数据库迁移完成。');
    return;
  }
  const activeSidecar = await sidecarController.ensureReady();
  await mainWindow.loadURL(await activeSidecar.createAdminLink());
  windowController.reveal();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windowController.reveal());
  app.on('activate', () => windowController.reveal());

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.pmbrain.desktop');
    logger = new DesktopLogger(app.getPath('userData'));
    const initialSetup = getSetupInfo();
    lanController.initialize();
    desktopVersionHistory = updateDesktopVersionHistory(
      join(app.getPath('userData'), 'version-history.json'),
      app.getVersion(),
      initialSetup.current.lastMigratedVersion,
    );
    systemSettingsController.applyTheme(initialSetup.current.theme);
    nativeTheme.on('updated', () => {
      windowController.current?.webContents.send('desktop:theme-state', systemSettingsController.themeState());
      systemSettingsController.sendState();
    });
    trayController.initialize();
    installAppMenu({
      openAdmin,
      openPanel: openSettingsPanel,
      openUpdates: () => updateController.open(),
      getLogger: () => logger,
      reportError: reportUiActionError,
    });
    const pgliteRecoveryDependencies: DesktopPgliteRecoveryDependencies = {
      setup: () => {
        const setup = getSetupInfo();
        return {
          needsSetup: setup.needsSetup,
          engine: setup.current.engine,
          databasePath: setup.current.databasePath,
        };
      },
      recoveryActive: () => sidecarController.state?.phase === 'failed',
      restart: async () => {
        await windowController.showShell();
        if (getSetupInfo().needsSetup) return undefined;
        return sidecarController.restartForRetry();
      },
    };
    registerDesktopIpcHandlers({
      assertTrustedSender: event => {
        const senderUrl = event.senderFrame?.url || event.sender.getURL();
        if (!isTrustedDesktopShellUrl(senderUrl, windowController.trustContext())) {
          throw new Error('已拒绝来自非 PMBrain 桌面设置页的方法调用。');
        }
      },
      mainWindow: () => windowController.current,
      state: () => sidecarController.state,
      startupProgress: () => startupProgress,
      theme: () => systemSettingsController.themeState(getSetupInfo().current.theme),
      setTheme: value => systemSettingsController.setTheme(value),
      systemSettings: () => systemSettingsController.currentState(),
      saveSystemSettings: payload => systemSettingsController.save(payload),
      sharedAccess: () => sharedAccessController.read(),
      createSharedIntegration: payload => sharedAccessController.create(payload),
      revokeSharedIntegration: credentialName => sharedAccessController.revoke(credentialName),
      updateState: () => updateController.currentState,
      setup: () => setupController.currentState(),
      inspectKnowledgeSourceDirectory,
      initializeKnowledgeSourceGit,
      providerModels: listDesktopProviderModels,
      testModelConnection,
      advancedModelConfig: () => readAdvancedModelConfig(runtime()),
      saveAdvancedModelConfig: values => sidecarController.withPausedForModelConfig(
        () => writeAdvancedModelConfig(runtime(), values),
      ),
      saveSetup: payload => setupController.apply(payload),
      chooseEmbeddingRebuild,
      configureIntegration: (client, kind) => sharedAccessController.configure(client, kind),
      writeWorkbuddyUserAgent: () => writeWorkbuddyUserAgent(),
      getWorkbuddyAgentIntegration: () => workBuddyAgentController.read(),
      installWorkbuddyAgent: workspace => workBuddyAgentController.install(workspace),
      updateWorkbuddyAgent: () => workBuddyAgentController.update(),
      removeWorkbuddyAgent: () => workBuddyAgentController.remove(),
      openAdmin,
      checkUpdates: () => updateController.check(),
      downloadUpdate: () => updateController.download(),
      installUpdate: () => updateController.install(),
      pgliteUpgradeBackups: () => pgliteBackupController.listUpgradeBackups(),
      prunePgliteUpgradeBackups: () => pgliteBackupController.pruneUpgradeBackups(),
      deletePgliteUpgradeBackup: backupDirectory => pgliteBackupController.deleteUpgradeBackup(backupDirectory),
      restorePgliteUpgradeBackup: backupDirectory => sidecarController.withPausedForPgliteBackupRestore(
        () => pgliteBackupController.restoreUpgradeBackup(backupDirectory),
      ),
      setPgliteUpgradeBackupRoot: directory => pgliteBackupController.setBackupRoot(directory),
      openPgliteUpgradeBackup: async target => {
        const path = await pgliteBackupController.resolveOpenableBackupPath(target);
        const error = await shell.openPath(path);
        if (error) throw new Error(`无法打开备份目录：${error}`);
      },
      previousVersion: () => desktopVersionHistory.previous,
      pgliteRecoveryStatus: () => inspectDesktopPgliteRecovery(pgliteRecoveryDependencies),
      terminatePgliteOwnerAndRetry: pid => terminateDesktopPgliteOwnerAndRetry(
        pid,
        pgliteRecoveryDependencies,
      ),
      retry: async () => {
        await windowController.showShell();
        if (getSetupInfo().needsSetup) return undefined;
        return sidecarController.restartForRetry();
      },
      openLogs: () => {
        if (logger) return shell.showItemInFolder(logger.filePath);
      },
      exportDiagnosticBundle,
    });
    lanController.startMonitor(LAN_MONITOR_INTERVAL_MS);
    await windowController.create();
    updateController.initialize();
  });

  app.on('before-quit', event => {
    if (quitting) return;
    updateController.stop();
    lanController.stopMonitor();
    if (!sidecarController.current) {
      quitting = true;
      trayController.destroy();
      logger?.close();
      return;
    }
    event.preventDefault();
    quitting = true;
    void sidecarController.stop().finally(() => {
      trayController.destroy();
      logger?.close();
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    if (getDesktopPreferences().closeBehavior === 'quit') app.quit();
  });
}
