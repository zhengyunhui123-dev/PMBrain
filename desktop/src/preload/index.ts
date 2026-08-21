import { contextBridge, ipcRenderer } from 'electron';
import type { SidecarState } from '../main/sidecar-manager.js';
import type {
  DesktopCloseBehavior,
  DesktopCustomEndpoint,
  DesktopCustomProvider,
  DesktopCustomProviderCatalog,
  DesktopCustomProviderSelection,
  DesktopNetworkMode,
  DesktopPreferences,
  DesktopTheme,
  SetupInfo,
  SetupPayload,
} from '../main/config-manager.js';
import type {
  AdvancedModelConfig,
  AdvancedModelPhase,
  AdvancedModelTier,
  AdvancedModelWriteInput,
} from '../main/advanced-model-config.js';
import type {
  CredentialKind,
  IntegrationClient,
  IntegrationInfo,
  IntegrationResult,
  SharedAccessContext,
  SharedCredentialInfo,
  SharedIntegrationPayload,
  SharedIntegrationResult,
  SharedSourceInfo,
} from '../main/integration-manager.js';
import type { UpdateState } from '../main/update-manager.js';
import type { DesktopModelTouchpoint, DesktopProviderModels } from '../main/model-catalog.js';
import type {
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
} from '../main/model-connection-test.js';
import type {
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
} from '../main/system-settings.js';
import type { DesktopKnowledgeSourceStatus } from '../main/knowledge-source-git.js';
import type { WorkbuddyAgentIntegrationStatus } from '../main/integration/workbuddy-agent-controller.js';
import type { PgliteOwnerStatus } from '../../../src/core/pglite-owner-control.js';

export type {
  AdvancedModelConfig,
  AdvancedModelPhase,
  AdvancedModelTier,
  AdvancedModelWriteInput,
  CredentialKind,
  DesktopCloseBehavior,
  DesktopCustomEndpoint,
  DesktopCustomProvider,
  DesktopCustomProviderCatalog,
  DesktopCustomProviderSelection,
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
  DesktopNetworkMode,
  DesktopKnowledgeSourceStatus,
  DesktopPreferences,
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
  DesktopTheme,
  IntegrationClient,
  IntegrationInfo,
  IntegrationResult,
  SharedAccessContext,
  SharedCredentialInfo,
  SharedIntegrationPayload,
  SharedIntegrationResult,
  SharedSourceInfo,
  SetupInfo,
  SetupPayload,
  SidecarState,
  UpdateState,
  WorkbuddyAgentIntegrationStatus,
};

export type DesktopSettingsPanel = 'basic' | 'models' | 'integrations' | 'updates' | 'system' | 'repair';

export interface DesktopPgliteUpgradeBackup {
  status: 'verified';
  backupDirectory: string;
  backupDatabasePath: string;
  manifestPath: string;
  createdAt: string;
  targetVersion: string;
  sourceSchemaVersion: number | null;
  recoveryVerifiedAt: string;
}

export interface DesktopPgliteUpgradeBackups {
  databasePath: string | null;
  backups: DesktopPgliteUpgradeBackup[];
}

export interface DesktopDiagnosticBundleResult {
  path: string;
  fileName: string;
  files: string[];
}

export interface DesktopThemeState {
  source: DesktopTheme;
  resolved: 'light' | 'dark';
  backup?: string | null;
}

export interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

export interface DesktopSetupState {
  setup: SetupInfo;
  integrations: IntegrationInfo[];
  port?: number;
  mcpUrl?: string;
}

export interface PMBrainDesktopApi {
  getState(): Promise<SidecarState | null>;
  getStartupProgress(): Promise<StartupProgress>;
  onStartupProgress(listener: (progress: StartupProgress) => void): () => void;
  getTheme(): Promise<DesktopThemeState>;
  setTheme(theme: DesktopTheme): Promise<DesktopThemeState>;
  onThemeState(listener: (state: DesktopThemeState) => void): () => void;
  getSetup(): Promise<DesktopSetupState>;
  onState(listener: (state: SidecarState) => void): () => void;
  getUpdateState(): Promise<UpdateState | null>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onShowUpdates(listener: () => void): () => void;
  onShowPanel(listener: (panel: DesktopSettingsPanel) => void): () => void;
  getSystemSettings(): Promise<DesktopSystemSettingsState>;
  saveSystemSettings(payload: DesktopSystemSettingsPayload): Promise<DesktopSystemSettingsSaveResult>;
  onSystemSettingsState(listener: (state: DesktopSystemSettingsState) => void): () => void;
  getSharedAccess(): Promise<SharedAccessContext>;
  createSharedIntegration(payload: SharedIntegrationPayload): Promise<SharedIntegrationResult>;
  revokeSharedIntegration(credentialName: string): Promise<SharedAccessContext>;
  chooseDirectory(initialPath?: string): Promise<string | null>;
  inspectKnowledgeSourceDirectory(path: string): Promise<DesktopKnowledgeSourceStatus>;
  initializeKnowledgeSourceGit(path: string): Promise<DesktopKnowledgeSourceStatus>;
  getProviderModels(provider: string, touchpoint: DesktopModelTouchpoint): Promise<DesktopProviderModels>;
  testModelConnection(input: DesktopModelConnectionTestInput): Promise<DesktopModelConnectionTestResult>;
  getAdvancedModelConfig(): Promise<AdvancedModelConfig>;
  saveAdvancedModelConfig(values: AdvancedModelWriteInput): Promise<AdvancedModelConfig>;
  saveSetup(payload: SetupPayload): Promise<DesktopSetupState & { backup?: string | null; reembeddingWarning?: string | null }>;
  configureIntegration(client: IntegrationClient, kind: CredentialKind): Promise<IntegrationResult>;
  writeWorkbuddyUserAgent(): Promise<{ written: string[]; backedUp: string[] }>;
  getWorkbuddyAgentIntegration(): Promise<WorkbuddyAgentIntegrationStatus>;
  installWorkbuddyAgent(workspace: string): Promise<WorkbuddyAgentIntegrationStatus>;
  updateWorkbuddyAgent(): Promise<WorkbuddyAgentIntegrationStatus>;
  removeWorkbuddyAgent(): Promise<WorkbuddyAgentIntegrationStatus>;
  copy(value: string): Promise<void>;
  openAdmin(): Promise<void>;
  checkUpdates(): Promise<UpdateState | null>;
  downloadUpdate(): Promise<UpdateState | null>;
  installUpdate(): Promise<void>;
  listPgliteUpgradeBackups(): Promise<DesktopPgliteUpgradeBackups>;
  getPgliteRecoveryStatus(): Promise<PgliteOwnerStatus>;
  terminatePgliteOwnerAndRetry(pid: number): Promise<void>;
  retry(): Promise<void>;
  openLogs(): Promise<string>;
  exportDiagnosticBundle(): Promise<DesktopDiagnosticBundleResult | null>;
  quit(): Promise<void>;
}

const api: PMBrainDesktopApi = {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  getStartupProgress: () => ipcRenderer.invoke('desktop:get-startup-progress'),
  onStartupProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: StartupProgress) => listener(progress);
    ipcRenderer.on('desktop:startup-progress', handler);
    return () => ipcRenderer.removeListener('desktop:startup-progress', handler);
  },
  getTheme: () => ipcRenderer.invoke('desktop:get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('desktop:set-theme', theme),
  onThemeState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopThemeState) => listener(state);
    ipcRenderer.on('desktop:theme-state', handler);
    return () => ipcRenderer.removeListener('desktop:theme-state', handler);
  },
  getSetup: () => ipcRenderer.invoke('desktop:get-setup'),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: SidecarState) => listener(state);
    ipcRenderer.on('desktop:state', handler);
    return () => ipcRenderer.removeListener('desktop:state', handler);
  },
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on('desktop:update-state', handler);
    return () => ipcRenderer.removeListener('desktop:update-state', handler);
  },
  onShowUpdates: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('desktop:show-updates', handler);
    return () => ipcRenderer.removeListener('desktop:show-updates', handler);
  },
  onShowPanel: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, panel: DesktopSettingsPanel) => listener(panel);
    ipcRenderer.on('desktop:show-panel', handler);
    return () => ipcRenderer.removeListener('desktop:show-panel', handler);
  },
  getSystemSettings: () => ipcRenderer.invoke('desktop:get-system-settings'),
  saveSystemSettings: (payload) => ipcRenderer.invoke('desktop:save-system-settings', payload),
  onSystemSettingsState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopSystemSettingsState) => listener(state);
    ipcRenderer.on('desktop:system-settings-state', handler);
    return () => ipcRenderer.removeListener('desktop:system-settings-state', handler);
  },
  getSharedAccess: () => ipcRenderer.invoke('desktop:get-shared-access'),
  createSharedIntegration: (payload) => ipcRenderer.invoke('desktop:create-shared-integration', payload),
  revokeSharedIntegration: (credentialName) => ipcRenderer.invoke('desktop:revoke-shared-integration', credentialName),
  chooseDirectory: (initialPath) => ipcRenderer.invoke('desktop:choose-directory', initialPath),
  inspectKnowledgeSourceDirectory: (path) => ipcRenderer.invoke('desktop:inspect-knowledge-source', path),
  initializeKnowledgeSourceGit: (path) => ipcRenderer.invoke('desktop:initialize-knowledge-source-git', path),
  getProviderModels: (provider, touchpoint) => ipcRenderer.invoke('desktop:get-provider-models', provider, touchpoint),
  testModelConnection: input => ipcRenderer.invoke('desktop:test-model-connection', input),
  getAdvancedModelConfig: () => ipcRenderer.invoke('desktop:get-advanced-model-config'),
  saveAdvancedModelConfig: (values) => ipcRenderer.invoke('desktop:save-advanced-model-config', values),
  saveSetup: (payload) => ipcRenderer.invoke('desktop:save-setup', payload),
  configureIntegration: (client, kind) => ipcRenderer.invoke('desktop:configure-integration', client, kind),
  writeWorkbuddyUserAgent: () => ipcRenderer.invoke('desktop:write-workbuddy-user-agent'),
  getWorkbuddyAgentIntegration: () => ipcRenderer.invoke('desktop:get-workbuddy-agent-integration'),
  installWorkbuddyAgent: (workspace) => ipcRenderer.invoke('desktop:install-workbuddy-agent', workspace),
  updateWorkbuddyAgent: () => ipcRenderer.invoke('desktop:update-workbuddy-agent'),
  removeWorkbuddyAgent: () => ipcRenderer.invoke('desktop:remove-workbuddy-agent'),
  copy: (value) => ipcRenderer.invoke('desktop:copy', value),
  openAdmin: () => ipcRenderer.invoke('desktop:open-admin'),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  listPgliteUpgradeBackups: () => ipcRenderer.invoke('desktop:list-pglite-upgrade-backups'),
  getPgliteRecoveryStatus: () => ipcRenderer.invoke('desktop:get-pglite-recovery-status'),
  terminatePgliteOwnerAndRetry: (pid) => ipcRenderer.invoke('desktop:terminate-pglite-owner-and-retry', pid),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  exportDiagnosticBundle: () => ipcRenderer.invoke('desktop:export-diagnostic-bundle'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
};

contextBridge.exposeInMainWorld('pmbrainDesktop', api);
