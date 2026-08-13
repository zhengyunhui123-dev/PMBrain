/**
 * 产品行为：深度接入复用现有 MCP 配置流程，把 Agent Pack 安装到用户选择的
 * WorkBuddy 工作目录；重复检查不会重新发凭证，卸载也不会删除基础 MCP。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationInfo, IntegrationResult } from '../src/main/integration-manager.js';
import { WorkBuddyAgentPackInstaller } from '../src/main/integration/agent-integration/index.js';
import { WorkBuddyAgentController } from '../src/main/integration/workbuddy-agent-controller.js';
import type { SidecarManager } from '../src/main/sidecar-manager.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-workbuddy-controller-'));
  roots.push(root);
  return root;
}

function harness() {
  const root = tempRoot();
  const workspace = join(root, 'workspace');
  const config = join(root, '.workbuddy', 'mcp.json');
  const receipt = join(root, '.pmbrain', 'agent-integrations', 'workbuddy.json');
  mkdirSync(workspace, { recursive: true });
  let configureCalls = 0;
  const manager = {
    port: 3131,
    mcpUrl: 'http://127.0.0.1:3131/mcp',
    smokeTest: async (token: string) => {
      if (token !== 'test-token') throw new Error('bad token');
      return { toolCount: 17, statsOk: true };
    },
  } as unknown as SidecarManager;
  const listMcpIntegrations = (port?: number): IntegrationInfo[] => [{
    id: 'workbuddy',
    name: 'WorkBuddy',
    path: config,
    automatic: true,
    configured: existsSync(config),
    configuredPort: existsSync(config) ? 3131 : undefined,
    portMismatch: existsSync(config) && port !== 3131,
  }];
  const configureMcp = async (): Promise<IntegrationResult> => {
    configureCalls += 1;
    mkdirSync(join(root, '.workbuddy'), { recursive: true });
    writeFileSync(config, JSON.stringify({
      connector_proxy: { keep: true },
      mcpServers: {
        pmbrain: {
          type: 'http',
          url: manager.mcpUrl,
          headers: { Authorization: 'Bearer test-token' },
        },
      },
    }), 'utf8');
    return {
      client: 'workbuddy',
      credentialKind: 'api_key',
      configured: true,
      path: config,
      backup: null,
      snippet: '{}',
      smoke: { toolCount: 17, statsOk: true },
    };
  };
  const controller = new WorkBuddyAgentController({
    sidecar: { current: manager, ensureReady: async () => manager },
    configureMcp,
    receiptPath: receipt,
    detectWorkBuddy: () => true,
    listMcpIntegrations,
    mcpConfigPath: () => config,
  });
  return { controller, workspace, config, receipt, configureCalls: () => configureCalls };
}

describe('WorkBuddy 深度接入 controller', () => {
  test('缺少 MCP 时复用配置流程，并在 Rules、Skills、MCP 都验证后保存工作目录', async () => {
    const testbed = harness();
    const status = await testbed.controller.install(testbed.workspace);

    expect(testbed.configureCalls()).toBe(1);
    expect(status).toMatchObject({
      state: 'installed',
      rulesInstalled: true,
      skillsInstalled: 5,
      skillsTotal: 5,
      mcpConfigured: true,
      mcpConnected: true,
    });
    expect(JSON.parse(readFileSync(testbed.receipt, 'utf8')).workspace).toBe(testbed.workspace);
    expect(JSON.parse(readFileSync(testbed.config, 'utf8')).connector_proxy).toEqual({ keep: true });
  });

  test('重新检查使用已保存 MCP，不重复配置或重发凭证', async () => {
    const testbed = harness();
    await testbed.controller.install(testbed.workspace);
    const status = await testbed.controller.read();

    expect(testbed.configureCalls()).toBe(1);
    expect(status.state).toBe('installed');
    expect(status.mcpConnected).toBe(true);
  });

  test('没有 receipt 时可从所选 workspace 修复不完整的官方 Pack', async () => {
    const testbed = harness();
    const installer = new WorkBuddyAgentPackInstaller({ workspace: testbed.workspace });
    await installer.install();
    rmSync(join(testbed.workspace, '.codebuddy', 'skills', 'remember', 'SKILL.md'));
    expect((await installer.getStatus()).state).toBe('incomplete');

    const status = await testbed.controller.install(testbed.workspace);

    expect(status.state).toBe('installed');
    expect(status.skillsInstalled).toBe(5);
    expect(existsSync(testbed.receipt)).toBe(true);
  });

  test('没有 receipt 时拒绝覆盖所选 workspace 中的用户文件', async () => {
    const testbed = harness();
    const rulesDir = join(testbed.workspace, '.codebuddy', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'pmbrain.md'), '# 用户自己的规则\n', 'utf8');

    await expect(testbed.controller.install(testbed.workspace)).rejects.toThrow('不会静默覆盖');
    expect(testbed.configureCalls()).toBe(0);
    expect(readFileSync(join(rulesDir, 'pmbrain.md'), 'utf8')).toBe('# 用户自己的规则\n');
    expect(existsSync(testbed.receipt)).toBe(false);
  });

  test('卸载只删除 PMBrain Agent Pack，保留 WorkBuddy MCP 配置', async () => {
    const testbed = harness();
    await testbed.controller.install(testbed.workspace);
    const status = await testbed.controller.remove();

    expect(status.state).toBe('not_installed');
    expect(existsSync(testbed.config)).toBe(true);
    expect(existsSync(join(testbed.workspace, '.codebuddy', 'rules', 'pmbrain.md'))).toBe(false);
    expect(existsSync(testbed.receipt)).toBe(false);
  });

  test('没有检测到 WorkBuddy 时不会写 MCP 或 Agent 文件', async () => {
    const testbed = harness();
    const controller = new WorkBuddyAgentController({
      sidecar: { current: null, ensureReady: async () => { throw new Error('must not start'); } },
      configureMcp: async () => { throw new Error('must not configure'); },
      receiptPath: testbed.receipt,
      detectWorkBuddy: () => false,
      listMcpIntegrations: () => [],
      mcpConfigPath: () => testbed.config,
    });

    await expect(controller.install(testbed.workspace)).rejects.toThrow('未检测到 WorkBuddy');
    expect(existsSync(testbed.config)).toBe(false);
    expect(existsSync(join(testbed.workspace, '.codebuddy'))).toBe(false);
  });
});
