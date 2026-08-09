import {
  configureIntegration,
  createSharedIntegration,
  getSharedAccessContext,
  revokeSharedIntegration,
  smokeTestSharedIntegration,
  type CredentialKind,
  type IntegrationClient,
  type SharedIntegrationPayload,
} from '../integration-manager.js';
import type { LanMcpGatewayStatus } from '../lan-mcp-gateway.js';
import type { LanController } from '../network/lan-controller.js';
import type { SidecarController } from '../sidecar/sidecar-controller.js';
import type { SidecarManager } from '../sidecar-manager.js';
import { getDesktopPreferences } from '../config-manager.js';

export class SharedAccessController {
  constructor(
    private readonly sidecarController: SidecarController,
    private readonly lanController: LanController,
  ) {}

  async read() {
    const shared = this.requireSidecar();
    return getSharedAccessContext(shared.sidecar, shared.mcpUrl);
  }

  async create(payload: SharedIntegrationPayload) {
    const shared = this.requireGateway();
    const result = await createSharedIntegration(shared.sidecar, shared.status.mcpUrl, payload);
    try {
      await smokeTestSharedIntegration(shared.status.mcpUrl, result.token, result.scopes, result.name);
    } catch (error) {
      try {
        await revokeSharedIntegration(shared.sidecar, result.name);
      } catch (rollbackError) {
        throw new Error(
          `共享凭证局域网校验失败，且自动撤销也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          + `。请立即在成员凭证列表中手动撤销 ${result.name}。`,
          { cause: error },
        );
      }
      throw error;
    }
    return result;
  }

  async revoke(credentialName: string) {
    const shared = this.requireSidecar();
    await revokeSharedIntegration(shared.sidecar, credentialName);
    return getSharedAccessContext(shared.sidecar, shared.mcpUrl);
  }

  async configure(client: IntegrationClient, kind: CredentialKind) {
    const sidecar = this.sidecarController.current;
    if (!sidecar) throw new Error('请先完成数据库配置并启动 PMBrain。');
    return configureIntegration(sidecar, client, kind);
  }

  private requireSidecar(): { sidecar: SidecarManager; mcpUrl: string } {
    const sidecar = this.sidecarController.current;
    if (!sidecar || this.sidecarController.state?.phase !== 'ready') throw new Error('请先启动 PMBrain 本地服务。');
    const sharedIp = getDesktopPreferences().sharedIp;
    if (!sharedIp) throw new Error('尚未保存局域网共享地址，当前没有可管理的共享入口。');
    return { sidecar, mcpUrl: `http://${sharedIp}:3131/mcp` };
  }

  private requireGateway(): { sidecar: SidecarManager; status: LanMcpGatewayStatus } {
    const sidecar = this.sidecarController.current;
    if (!sidecar || this.sidecarController.state?.phase !== 'ready') throw new Error('请先启动 PMBrain 本地服务。');
    if (getDesktopPreferences().networkMode !== 'shared') {
      throw new Error('请先在系统设置中启用局域网共享模式。');
    }
    const status = this.lanController.status;
    if (!status?.running) {
      throw new Error(this.lanController.warning || '局域网 MCP 尚未启动，请检查固定 IP 和端口状态。');
    }
    return { sidecar, status };
  }
}
