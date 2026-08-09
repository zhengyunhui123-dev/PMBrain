import type { DesktopPreferences } from '../config-manager.js';
import type { DesktopLogger } from '../logs.js';
import { LanMcpGateway, type LanMcpGatewayStatus } from '../lan-mcp-gateway.js';
import type { NetworkCandidate } from '../network-manager.js';
import type { SidecarManager, SidecarState } from '../sidecar-manager.js';

export interface LanControllerDependencies {
  getPreferences: () => DesktopPreferences;
  savePreferences: (updates: Partial<DesktopPreferences>) => unknown;
  listCandidates: () => NetworkCandidate[];
  getSidecar: () => SidecarManager | null;
  getSidecarState: () => SidecarState | null;
  sendSystemSettingsState: () => void;
  showNotification: (title: string, body: string) => void;
  getLogger: () => DesktopLogger | null;
}

export class LanController {
  private gateway: LanMcpGateway | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private warningValue: string | undefined;
  private selectedAddressWasUnavailableValue = false;
  private checkInFlight = false;
  private transitionQueue: Promise<void> = Promise.resolve();
  private transitionGeneration = 0;

  constructor(private readonly dependencies: LanControllerDependencies) {}

  get status(): LanMcpGatewayStatus | null {
    return this.gateway?.getStatus() ?? null;
  }

  get warning(): string | undefined {
    return this.warningValue;
  }

  get selectedAddressWasUnavailable(): boolean {
    return this.selectedAddressWasUnavailableValue;
  }

  initialize(): void {
    this.selectedAddressWasUnavailableValue = this.dependencies.getPreferences().sharedResumeRequired;
  }

  startMonitor(intervalMs: number): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => void this.checkSelectedNetworkAddress(), intervalMs);
  }

  stopMonitor(): void {
    if (!this.monitor) return;
    clearInterval(this.monitor);
    this.monitor = null;
  }

  resetAfterSettingsSave(sharedResumeRequired: boolean): void {
    this.selectedAddressWasUnavailableValue = sharedResumeRequired;
    this.warningValue = undefined;
  }

  selectedAddressAvailable(): boolean {
    const preferences = this.dependencies.getPreferences();
    return this.dependencies.listCandidates().some(candidate => (
      candidate.adapterName === preferences.sharedAdapter
      && candidate.address === preferences.sharedIp
      && candidate.recommended
    ));
  }

  private markSharedResumeRequired(required: boolean): void {
    this.selectedAddressWasUnavailableValue = required;
    try {
      const current = this.dependencies.getPreferences();
      if (current.sharedResumeRequired !== required) {
        this.dependencies.savePreferences({ sharedResumeRequired: required });
      }
    } catch (error) {
      this.dependencies.getLogger()?.write(
        'desktop',
        `Unable to persist shared resume state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private queueTransition<T>(transition: () => Promise<T>): Promise<T> {
    const pending = this.transitionQueue.then(transition, transition);
    this.transitionQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async stopNow(clear = true): Promise<void> {
    const active = this.gateway;
    if (clear) this.gateway = null;
    if (active) await active.stop();
  }

  stop(clear = true): Promise<void> {
    this.transitionGeneration += 1;
    return this.queueTransition(() => this.stopNow(clear));
  }

  reconcile(): Promise<LanMcpGatewayStatus | null> {
    const generation = ++this.transitionGeneration;
    return this.queueTransition(() => this.reconcileNow(generation));
  }

  private async reconcileNow(generation: number): Promise<LanMcpGatewayStatus | null> {
    if (generation !== this.transitionGeneration) return null;
    const preferences = this.dependencies.getPreferences();
    const sidecar = this.dependencies.getSidecar();
    this.selectedAddressWasUnavailableValue ||= preferences.sharedResumeRequired;
    if (preferences.networkMode !== 'shared' || !sidecar || this.dependencies.getSidecarState()?.phase !== 'ready') {
      await this.stopNow();
      if (preferences.networkMode !== 'shared') this.warningValue = undefined;
      this.dependencies.sendSystemSettingsState();
      return null;
    }
    if (!preferences.sharedAdapter || !preferences.sharedIp) {
      await this.stopNow();
      this.warningValue = '共享模式缺少固定网卡或 IPv4，请在系统设置中重新选择。';
      this.dependencies.sendSystemSettingsState();
      return null;
    }
    const selectedCandidate = this.dependencies.listCandidates().find(candidate => (
      candidate.adapterName === preferences.sharedAdapter && candidate.address === preferences.sharedIp
    ));
    if (!selectedCandidate?.recommended) {
      const firstLoss = !this.selectedAddressWasUnavailableValue;
      this.markSharedResumeRequired(true);
      await this.stopNow();
      this.warningValue = selectedCandidate
        ? `固定地址 ${preferences.sharedIp} 不符合局域网共享安全要求：${selectedCandidate.warning || '只允许真实网卡上的私有 IPv4。'}`
        : `固定地址 ${preferences.sharedIp} 已不在网卡“${preferences.sharedAdapter}”上，局域网共享已停止。`;
      if (firstLoss) {
        this.dependencies.showNotification('PMBrain 局域网共享已停止', `${preferences.sharedIp} 当前不可用；地址恢复后仍需手动确认共享。`);
      }
      this.dependencies.sendSystemSettingsState();
      return null;
    }

    if (this.selectedAddressWasUnavailableValue) {
      await this.stopNow();
      this.warningValue = `固定地址 ${preferences.sharedIp} 已重新出现，但为防止切换到其他 WiFi 后误共享，仍保持停用；请在系统设置中确认并重新应用共享模式。`;
      this.dependencies.sendSystemSettingsState();
      return null;
    }

    const currentGateway = this.gateway?.getStatus();
    if (
      currentGateway?.running
      && currentGateway.bindAddress === preferences.sharedIp
      && currentGateway.targetMcpUrl === sidecar.mcpUrl
    ) {
      return currentGateway;
    }

    await this.stopNow();
    if (generation !== this.transitionGeneration) return null;
    const gateway = new LanMcpGateway({
      bindAddress: preferences.sharedIp,
      sidecarPort: sidecar.port,
      verifyBearerToken: authorizationHeader => sidecar.verifyMcpBearer(authorizationHeader),
    });
    try {
      const status = await gateway.start();
      if (generation !== this.transitionGeneration) {
        await gateway.stop();
        return null;
      }
      this.gateway = gateway;
      this.warningValue = undefined;
      this.selectedAddressWasUnavailableValue = false;
      this.dependencies.getLogger()?.write('desktop', `LAN MCP gateway ready at ${status.mcpUrl}; target ${status.targetMcpUrl}`);
      this.dependencies.sendSystemSettingsState();
      return status;
    } catch (error) {
      await gateway.stop().catch(() => undefined);
      if (generation !== this.transitionGeneration) return null;
      const causeCode = (error as Error & { cause?: NodeJS.ErrnoException })?.cause?.code;
      if (causeCode === 'EADDRNOTAVAIL') this.markSharedResumeRequired(true);
      this.warningValue = error instanceof Error ? error.message : String(error);
      this.dependencies.getLogger()?.write('desktop', this.warningValue);
      this.dependencies.sendSystemSettingsState();
      return null;
    }
  }

  async checkSelectedNetworkAddress(): Promise<void> {
    if (this.checkInFlight) return;
    this.checkInFlight = true;
    try {
      const preferences = this.dependencies.getPreferences();
      if (preferences.networkMode !== 'shared' || !preferences.sharedAdapter || !preferences.sharedIp) return;
      const selectedCandidate = this.dependencies.listCandidates().find(candidate => (
        candidate.adapterName === preferences.sharedAdapter && candidate.address === preferences.sharedIp
      ));
      const available = selectedCandidate?.recommended === true;
      if (!available && !this.selectedAddressWasUnavailableValue) {
        this.markSharedResumeRequired(true);
        await this.stop();
        this.warningValue = `固定地址 ${preferences.sharedIp} 已消失，局域网 MCP 已立即停止；不会自动切换到其他网卡。`;
        this.dependencies.getLogger()?.write('desktop', this.warningValue);
        this.dependencies.showNotification('PMBrain 局域网共享已停止', `${preferences.sharedIp} 已不在所选网卡上，请打开系统设置确认网络。`);
        this.dependencies.sendSystemSettingsState();
        return;
      }
      if (available && this.selectedAddressWasUnavailableValue) {
        const nextWarning = `固定地址 ${preferences.sharedIp} 已重新出现，但共享不会自动恢复；请确认当前仍是可信局域网后，在系统设置中重新应用。`;
        if (this.warningValue !== nextWarning) {
          this.warningValue = nextWarning;
          this.dependencies.showNotification('PMBrain 等待确认恢复共享', '为避免换到其他 WiFi 后误开放，请在系统设置中手动确认。');
          this.dependencies.sendSystemSettingsState();
        }
        return;
      }
      if (!this.gateway?.getStatus().running) await this.reconcile();
    } finally {
      this.checkInFlight = false;
    }
  }
}
