import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import type { AdvancedModelWriteInput } from './advanced-model-config.js';
import type { CredentialKind, IntegrationClient, SharedIntegrationPayload } from './integration-manager.js';
import type { DesktopModelTouchpoint } from './model-catalog.js';
import type {
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
} from './model-connection-test.js';
import type { SidecarState } from './sidecar-manager.js';
import type {
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
} from './system-settings.js';
import type { DesktopTheme, SetupPayload } from './config-manager.js';
import type { UpdateState } from './update-manager.js';
import type { DesktopPgliteUpgradeBackups } from '../preload/index.js';
import type { DesktopKnowledgeSourceStatus } from './knowledge-source-git.js';
import type { PgliteOwnerStatus } from '../../../src/core/pglite-owner-control.js';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any;

export interface DesktopIpcHandlers {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  mainWindow: () => BrowserWindow | null;
  state: () => SidecarState | null;
  startupProgress: () => unknown;
  theme: () => unknown;
  setTheme: (value: DesktopTheme) => unknown;
  systemSettings: () => DesktopSystemSettingsState;
  saveSystemSettings: (payload: DesktopSystemSettingsPayload) => Promise<DesktopSystemSettingsSaveResult>;
  sharedAccess: () => Promise<unknown>;
  createSharedIntegration: (payload: SharedIntegrationPayload) => Promise<unknown>;
  revokeSharedIntegration: (credentialName: string) => Promise<unknown>;
  updateState: () => UpdateState | null;
  setup: () => Promise<unknown>;
  inspectKnowledgeSourceDirectory: (path: string) => DesktopKnowledgeSourceStatus;
  initializeKnowledgeSourceGit: (path: string) => DesktopKnowledgeSourceStatus;
  providerModels: (provider: string, touchpoint: DesktopModelTouchpoint) => unknown;
  testModelConnection: (input: DesktopModelConnectionTestInput) => Promise<DesktopModelConnectionTestResult>;
  advancedModelConfig: () => Promise<unknown>;
  saveAdvancedModelConfig: (values: AdvancedModelWriteInput) => Promise<unknown>;
  saveSetup: (payload: SetupPayload) => Promise<unknown>;
  configureIntegration: (client: IntegrationClient, kind: CredentialKind) => Promise<unknown>;
  writeWorkbuddyUserAgent: () => Promise<unknown>;
  getWorkbuddyAgentIntegration: () => Promise<unknown>;
  installWorkbuddyAgent: (workspace: string) => Promise<unknown>;
  updateWorkbuddyAgent: () => Promise<unknown>;
  removeWorkbuddyAgent: () => Promise<unknown>;
  openAdmin: () => Promise<void>;
  checkUpdates: () => Promise<unknown> | undefined;
  downloadUpdate: () => Promise<unknown> | undefined;
  installUpdate: () => Promise<unknown> | undefined;
  pgliteUpgradeBackups: () => Promise<DesktopPgliteUpgradeBackups>;
  previousVersion: () => string | undefined;
  pgliteRecoveryStatus: () => Promise<PgliteOwnerStatus>;
  terminatePgliteOwnerAndRetry: (pid: number) => Promise<string | undefined>;
  retry: () => Promise<string | undefined>;
  openLogs: () => Promise<void> | void;
  exportDiagnosticBundle: () => Promise<unknown>;
}

function registerTrustedHandler(
  channel: string,
  handlers: DesktopIpcHandlers,
  listener: IpcHandler,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    handlers.assertTrustedSender(event);
    return listener(event, ...args);
  });
}

export function registerDesktopIpcHandlers(handlers: DesktopIpcHandlers): void {
  registerTrustedHandler('desktop:get-state', handlers, () => handlers.state());
  registerTrustedHandler('desktop:get-startup-progress', handlers, () => handlers.startupProgress());
  registerTrustedHandler('desktop:get-theme', handlers, () => handlers.theme());
  registerTrustedHandler('desktop:set-theme', handlers, (_event, value: DesktopTheme) => handlers.setTheme(value));
  registerTrustedHandler('desktop:get-system-settings', handlers, () => handlers.systemSettings());
  registerTrustedHandler('desktop:save-system-settings', handlers, (_event, payload: DesktopSystemSettingsPayload) => handlers.saveSystemSettings(payload));
  registerTrustedHandler('desktop:get-shared-access', handlers, () => handlers.sharedAccess());
  registerTrustedHandler('desktop:create-shared-integration', handlers, (_event, payload: SharedIntegrationPayload) => handlers.createSharedIntegration(payload));
  registerTrustedHandler('desktop:revoke-shared-integration', handlers, (_event, credentialName: string) => handlers.revokeSharedIntegration(credentialName));
  registerTrustedHandler('desktop:get-update-state', handlers, () => handlers.updateState());
  registerTrustedHandler('desktop:get-setup', handlers, () => handlers.setup());
  registerTrustedHandler('desktop:inspect-knowledge-source', handlers, (_event, path: string) => handlers.inspectKnowledgeSourceDirectory(path));
  registerTrustedHandler('desktop:initialize-knowledge-source-git', handlers, (_event, path: string) => handlers.initializeKnowledgeSourceGit(path));
  registerTrustedHandler('desktop:choose-directory', handlers, async (_event, initialPath?: string) => {
    const window = handlers.mainWindow();
    if (!window) throw new Error('PMBrain 桌面窗口尚未就绪。');
    const result = await dialog.showOpenDialog(window, {
      defaultPath: initialPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  registerTrustedHandler('desktop:get-provider-models', handlers, (_event, provider: string, touchpoint: DesktopModelTouchpoint) => handlers.providerModels(provider, touchpoint));
  registerTrustedHandler('desktop:test-model-connection', handlers, (_event, input: DesktopModelConnectionTestInput) => handlers.testModelConnection(input));
  registerTrustedHandler('desktop:get-advanced-model-config', handlers, () => handlers.advancedModelConfig());
  registerTrustedHandler('desktop:save-advanced-model-config', handlers, (_event, values: AdvancedModelWriteInput) => handlers.saveAdvancedModelConfig(values ?? {}));
  registerTrustedHandler('desktop:save-setup', handlers, (_event, payload: SetupPayload) => handlers.saveSetup(payload));
  registerTrustedHandler('desktop:configure-integration', handlers, (_event, client: IntegrationClient, kind: CredentialKind) => handlers.configureIntegration(client, kind));
  registerTrustedHandler('desktop:write-workbuddy-user-agent', handlers, () => handlers.writeWorkbuddyUserAgent());
  registerTrustedHandler('desktop:get-workbuddy-agent-integration', handlers, () => handlers.getWorkbuddyAgentIntegration());
  registerTrustedHandler('desktop:install-workbuddy-agent', handlers, (_event, workspace: string) => handlers.installWorkbuddyAgent(workspace));
  registerTrustedHandler('desktop:update-workbuddy-agent', handlers, () => handlers.updateWorkbuddyAgent());
  registerTrustedHandler('desktop:remove-workbuddy-agent', handlers, () => handlers.removeWorkbuddyAgent());
  registerTrustedHandler('desktop:copy', handlers, (_event, value: string) => clipboard.writeText(value));
  registerTrustedHandler('desktop:open-admin', handlers, () => handlers.openAdmin());
  registerTrustedHandler('desktop:check-updates', handlers, () => handlers.checkUpdates());
  registerTrustedHandler('desktop:download-update', handlers, () => handlers.downloadUpdate());
  registerTrustedHandler('desktop:install-update', handlers, () => handlers.installUpdate());
  registerTrustedHandler('desktop:list-pglite-upgrade-backups', handlers, () => handlers.pgliteUpgradeBackups());
  registerTrustedHandler('desktop:open-previous-release', handlers, async () => {
    const previous = handlers.previousVersion();
    if (!previous) throw new Error('当前没有可用的上一版本记录。');
    await shell.openExternal(`https://github.com/zhengyunhui123-dev/PMBrain/releases/tag/v${previous}`);
  });
  registerTrustedHandler('desktop:get-pglite-recovery-status', handlers, () => handlers.pgliteRecoveryStatus());
  registerTrustedHandler('desktop:terminate-pglite-owner-and-retry', handlers, async (_event, pid: number) => {
    const url = await handlers.terminatePgliteOwnerAndRetry(pid);
    if (url) await handlers.mainWindow()?.loadURL(url);
  });
  registerTrustedHandler('desktop:retry', handlers, async () => {
    const url = await handlers.retry();
    if (url) await handlers.mainWindow()?.loadURL(url);
  });
  registerTrustedHandler('desktop:open-logs', handlers, () => handlers.openLogs());
  registerTrustedHandler('desktop:export-diagnostic-bundle', handlers, () => handlers.exportDiagnosticBundle());
  registerTrustedHandler('desktop:quit', handlers, () => app.quit());
}
