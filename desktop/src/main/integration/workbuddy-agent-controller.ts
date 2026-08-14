import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { activeConfigDirectory } from '../config-manager.js';
import {
  integrationConfigPath,
  listIntegrations,
  type IntegrationInfo,
  type IntegrationResult,
} from '../integration-manager.js';
import type { SidecarManager } from '../sidecar-manager.js';
import {
  WORKBUDDY_AGENT_PACK_VERSION,
  WorkBuddyAgentPackInstaller,
  type AgentPackOperationResult,
  type AgentPackState,
  type AgentPackStatus,
} from './agent-integration/index.js';

const RECEIPT_SCHEMA_VERSION = 1 as const;

interface WorkBuddyReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  workspace: string;
}

export interface WorkbuddyAgentIntegrationStatus {
  state: AgentPackState;
  workbuddyDetected: boolean;
  workspace: string | null;
  packVersion: string;
  installedPackVersion: string | null;
  rulesInstalled: boolean;
  skillsInstalled: number;
  skillsTotal: number;
  mcpConfigured: boolean;
  mcpConnected: boolean;
  modifiedFiles: string[];
  missingFiles: string[];
  message: string;
}

interface SidecarAccess {
  current: SidecarManager | null;
  ensureReady(): Promise<SidecarManager>;
}

export interface WorkBuddyAgentControllerDependencies {
  sidecar: SidecarAccess;
  configureMcp: () => Promise<IntegrationResult>;
  receiptPath?: string;
  homeDir?: string;
  detectWorkBuddy?: () => boolean;
  listMcpIntegrations?: (currentPort?: number) => IntegrationInfo[];
  mcpConfigPath?: () => string | null;
  installerFactory?: (workspace?: string | null) => WorkBuddyAgentPackInstaller;
}

function defaultReceiptPath(): string {
  return join(activeConfigDirectory(), 'agent-integrations', 'workbuddy.json');
}

function defaultWorkBuddyDetection(homeDir = homedir()): boolean {
  const candidates = [
    join(homeDir, '.workbuddy'),
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Tencent', 'WorkBuddy', 'WorkBuddy.exe') : '',
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Tencent', 'WorkBuddy', 'WorkBuddy.exe') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe') : '',
  ];
  return candidates.some(path => Boolean(path) && existsSync(path));
}

function basePackStatus(): AgentPackStatus {
  return {
    state: 'not_installed',
    workspace: null,
    packVersion: WORKBUDDY_AGENT_PACK_VERSION,
    installedPackVersion: null,
    rulesInstalled: false,
    skillsInstalled: 0,
    skillsTotal: 5,
    modifiedFiles: [],
    missingFiles: [],
    message: '请选择 WorkBuddy 工作目录。',
  };
}

export class WorkBuddyAgentController {
  private readonly receiptPath: string;
  private readonly detectWorkBuddy: () => boolean;
  private readonly listMcpIntegrations: (currentPort?: number) => IntegrationInfo[];
  private readonly mcpConfigPath: () => string | null;
  private readonly installerFactory: (workspace?: string | null) => WorkBuddyAgentPackInstaller;

  constructor(private readonly dependencies: WorkBuddyAgentControllerDependencies) {
    this.receiptPath = resolve(dependencies.receiptPath ?? defaultReceiptPath());
    this.detectWorkBuddy = dependencies.detectWorkBuddy
      ?? (() => defaultWorkBuddyDetection(dependencies.homeDir));
    this.listMcpIntegrations = dependencies.listMcpIntegrations ?? listIntegrations;
    this.mcpConfigPath = dependencies.mcpConfigPath ?? (() => integrationConfigPath('workbuddy'));
    this.installerFactory = dependencies.installerFactory
      ?? ((workspace) => new WorkBuddyAgentPackInstaller({ workspace }));
  }

  async read(): Promise<WorkbuddyAgentIntegrationStatus> {
    const workspace = await this.readWorkspaceReceipt();
    const pack = workspace
      ? await this.installerFactory(workspace).getStatus()
      : basePackStatus();
    return this.composeStatus(pack);
  }

  async install(workspace: string): Promise<WorkbuddyAgentIntegrationStatus> {
    this.requireDetectedWorkBuddy();
    const installer = this.installerFactory(workspace);
    const existing = await installer.getStatus();
    if (existing.state === 'modified') {
      throw new Error('所选工作目录包含用户文件或已修改的 PMBrain Agent Pack，不会静默覆盖。');
    }
    await this.ensureMcpConnected();
    const result = existing.state === 'incomplete' || existing.state === 'update_available'
      ? await installer.update()
      : await installer.install();
    await this.assertPackVerified(installer, result);
    await this.writeWorkspaceReceipt(result.status.workspace);
    return this.composeStatus(result.status, true);
  }

  async update(): Promise<WorkbuddyAgentIntegrationStatus> {
    this.requireDetectedWorkBuddy();
    const workspace = await this.requireWorkspaceReceipt();
    await this.ensureMcpConnected();
    const installer = this.installerFactory(workspace);
    const result = await installer.update();
    await this.assertPackVerified(installer, result);
    return this.composeStatus(result.status, true);
  }

  async remove(): Promise<WorkbuddyAgentIntegrationStatus> {
    const workspace = await this.requireWorkspaceReceipt();
    const result = await this.installerFactory(workspace).uninstall();
    if (result.preservedFiles.length === 0 && result.status.state === 'not_installed') {
      await this.removeWorkspaceReceipt();
    }
    const status = await this.composeStatus(result.status);
    if (result.preservedFiles.length > 0) {
      return {
        ...status,
        state: 'modified',
        message: `已移除未修改的 PMBrain 内容；保留了 ${result.preservedFiles.length} 个用户修改文件。`,
      };
    }
    return { ...status, message: '已移除 PMBrain Agent Rules 与 Skills；基础 MCP 配置保持不变。' };
  }

  private requireDetectedWorkBuddy(): void {
    if (!this.detectWorkBuddy()) {
      throw new Error('未检测到 WorkBuddy。请先安装或启动受支持版本后重试。');
    }
  }

  private async assertPackVerified(
    installer: WorkBuddyAgentPackInstaller,
    result: AgentPackOperationResult,
  ): Promise<void> {
    const verification = await installer.verify();
    if (!verification.valid || !verification.rulesReadable || verification.skillsReadable < 1) {
      throw new Error(`WorkBuddy Agent Pack 安装后验证失败：${verification.issues.join('；')}`);
    }
    if (result.status.workspace !== verification.status.workspace) {
      throw new Error('WorkBuddy Agent Pack 安装目录验证不一致。');
    }
  }

  private async ensureMcpConnected(): Promise<void> {
    const sidecar = await this.dependencies.sidecar.ensureReady();
    const info = this.workBuddyMcpInfo(sidecar.port);
    if (!info?.configured || info.portMismatch || !await this.smokeExistingMcp(sidecar)) {
      const configured = await this.dependencies.configureMcp();
      if (!configured.configured || !configured.smoke?.statsOk || configured.smoke.toolCount < 1) {
        throw new Error('WorkBuddy MCP 配置后验证失败。');
      }
    }
    if (!await this.smokeExistingMcp(sidecar)) {
      throw new Error('WorkBuddy 无法通过现有 MCP 调用 PMBrain。');
    }
  }

  private workBuddyMcpInfo(currentPort?: number): IntegrationInfo | undefined {
    return this.listMcpIntegrations(currentPort).find(item => item.id === 'workbuddy');
  }

  private async smokeExistingMcp(sidecar: SidecarManager): Promise<boolean> {
    const path = this.mcpConfigPath();
    if (!path) return false;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        mcpServers?: { pmbrain?: { url?: unknown; headers?: { Authorization?: unknown } } };
      };
      const entry = parsed.mcpServers?.pmbrain;
      const authorization = entry?.headers?.Authorization;
      if (entry?.url !== sidecar.mcpUrl || typeof authorization !== 'string') return false;
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match?.[1]) return false;
      const smoke = await sidecar.smokeTest(match[1]);
      return smoke.toolCount > 0 && smoke.statsOk;
    } catch {
      return false;
    }
  }

  private async composeStatus(
    pack: AgentPackStatus,
    knownMcpConnected?: boolean,
  ): Promise<WorkbuddyAgentIntegrationStatus> {
    const sidecar = this.dependencies.sidecar.current;
    const info = this.workBuddyMcpInfo(sidecar?.port);
    const mcpConfigured = info?.configured === true && info.portMismatch !== true;
    const mcpConnected = knownMcpConnected === true
      || Boolean(sidecar && mcpConfigured && await this.smokeExistingMcp(sidecar));
    const state = pack.state === 'installed' && (!mcpConfigured || !mcpConnected)
      ? 'incomplete'
      : pack.state;
    const message = state === 'incomplete' && pack.state === 'installed'
      ? 'Agent Rules 与 Skills 已安装，但 WorkBuddy MCP 尚未连通。'
      : pack.message;
    return {
      state,
      workbuddyDetected: this.detectWorkBuddy(),
      workspace: pack.workspace,
      packVersion: pack.packVersion,
      installedPackVersion: pack.installedPackVersion,
      rulesInstalled: pack.rulesInstalled,
      skillsInstalled: pack.skillsInstalled,
      skillsTotal: pack.skillsTotal,
      mcpConfigured,
      mcpConnected,
      modifiedFiles: pack.modifiedFiles,
      missingFiles: pack.missingFiles,
      message,
    };
  }

  private async readWorkspaceReceipt(): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(this.receiptPath, 'utf8')) as Partial<WorkBuddyReceipt>;
      if (parsed.schemaVersion !== RECEIPT_SCHEMA_VERSION || typeof parsed.workspace !== 'string') return null;
      return parsed.workspace.trim() ? resolve(parsed.workspace) : null;
    } catch {
      return null;
    }
  }

  private async requireWorkspaceReceipt(): Promise<string> {
    const workspace = await this.readWorkspaceReceipt();
    if (!workspace) throw new Error('尚未记录 WorkBuddy 深度接入的工作目录，请重新接入。');
    return workspace;
  }

  private async writeWorkspaceReceipt(workspace: string | null): Promise<void> {
    if (!workspace) throw new Error('WorkBuddy Agent Pack 未返回有效工作目录。');
    await mkdir(dirname(this.receiptPath), { recursive: true });
    const temporary = `${this.receiptPath}.pmbrain-tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      workspace: resolve(workspace),
    } satisfies WorkBuddyReceipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, this.receiptPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new Error(`无法保存 WorkBuddy 深度接入记录：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async removeWorkspaceReceipt(): Promise<void> {
    await rm(this.receiptPath, { force: true });
  }
}
