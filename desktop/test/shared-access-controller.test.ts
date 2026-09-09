import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedAccessController } from '../src/main/integration/shared-access-controller.js';

const roots: string[] = [];
const previousGrokHome = process.env.GROK_HOME;

afterEach(() => {
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Grok Build 深度接入写入原生 MCP，并安装其可读取的 Claude 兼容合同', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-grok-deep-'));
  roots.push(root);
  process.env.GROK_HOME = root;
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const sidecar = {
    port: 3131,
    mcpUrl: 'http://127.0.0.1:3131/mcp',
    smokeTest: async () => ({ toolCount: 99, statsOk: true }),
    adminRequest: async (path: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ path, body });
      if (path === '/admin/api/api-keys') return { token: 'secret' };
      return {};
    },
  };
  const controller = new SharedAccessController(
    { current: sidecar } as never,
    {} as never,
  );

  const result = await controller.configure('grok', 'api_key', true);

  expect(result.configured).toBe(true);
  expect(readFileSync(join(root, 'config.toml'), 'utf8')).toContain('[mcp_servers.pmbrain]');
  const registration = requests.find(request => request.path === '/admin/api/memory/writeback/agent');
  expect(registration?.body).toMatchObject({
    agent: 'claude',
    mcpConfirmed: true,
    serveUrl: 'http://127.0.0.1:3131/mcp',
  });
});
