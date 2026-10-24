import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import { LanMcpGateway } from '../desktop/src/main/lan-mcp-gateway';

const home = mkdtempSync(join(tmpdir(), 'pmbrain-memory-network-test-'));
const config = { engine: 'pglite' as const, database_path: join(home, 'database'), mcp_surface: 'full' };
let processHandle: ReturnType<typeof Bun.spawn>;
let gateway: LanMcpGateway;
let origin: string;
let endpoint: string;
let cookie: string;
let requestId = 0;
let writeKey: { name: string; token: string };
let readKey: { name: string; token: string };

function frame(text: string): any {
  return JSON.parse(text.trimStart().startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data:'))!.slice(5));
}

async function rpc(url: string, token: string, method: string, params?: unknown) {
  return fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) });
}

async function admin(path: string, body?: unknown) {
  const response = await fetch(origin + '/admin/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value: any = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

const initialize = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'memory-network-fixture', version: '1' } };

beforeAll(async () => {
  configureGateway({ env: {} });
  mkdirSync(join(home, '.pmbrain'));
  writeFileSync(join(home, '.pmbrain', 'config.json'), JSON.stringify(config));
  const engine = new PGLiteEngine();
  await engine.connect(config);
  await engine.initSchema();
  await engine.disconnect();
  const port = await new Promise<number>(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PMBRAIN_') && !key.startsWith('GBRAIN_') && !key.endsWith('_API_KEY') && !['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key)));
  const bootstrap = 'memory-network-test-only-000000000000000000';
  Object.assign(env, { PMBRAIN_HOME: home, GBRAIN_HOME: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), PMBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrap, PMBRAIN_DIAGNOSTIC_MODE: '1' });
  const log = openSync(join(home, 'sidecar.log'), 'w');
  processHandle = Bun.spawn([process.execPath, resolve('src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--suppress-bootstrap-token'], { env, stdout: log, stderr: log });
  closeSync(log);
  let ready = false;
  for (let n = 0; n < 160; n++) { try { if ((await fetch(origin + '/health')).ok) { ready = true; break; } } catch {} await Bun.sleep(250); }
  expect(ready).toBe(true);
  const login = await fetch(origin + '/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: bootstrap }) });
  expect(login.ok).toBe(true);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  writeKey = await admin('api-keys', { name: 'shared:memory-writer', scopes: 'read write', sourceId: 'default', federatedRead: ['default'] });
  readKey = await admin('api-keys', { name: 'shared:memory-reader', scopes: 'read', federatedRead: ['default'] });
  gateway = new LanMcpGateway({ bindAddress: '127.0.0.1', listenPort: 0, sidecarPort: port, verifyBearerToken: async authorization => (await rpc(origin + '/mcp', authorization.slice(7), 'initialize', initialize)).ok });
  endpoint = (await gateway.start()).mcpUrl;
}, 60000);

afterAll(async () => { await gateway?.stop(); if (processHandle) { processHandle.kill(); await processHandle.exited; } resetGateway(); }, 30000);

test('真实共享链路按权限实时读取记忆模式，拒绝未授权请求和管理接口', async () => {
  expect((await rpc(endpoint, 'invalid-test-token', 'initialize', initialize)).status).toBe(401);
  expect((await fetch(endpoint.replace('/mcp', '/admin/api/memory/writeback'))).status).toBe(404);
  await admin('memory/writeback', { mode: 'salient', ttl: '12h' });
  const writer = frame(await (await rpc(endpoint, writeKey.token, 'initialize', initialize)).text());
  expect(writer.result.instructions).toContain('mode: salient');
  const reader = frame(await (await rpc(endpoint, readKey.token, 'initialize', initialize)).text());
  expect(reader.result.instructions).not.toContain('ambient writeback');
  await admin('memory/writeback', { mode: 'all' });
  expect(frame(await (await rpc(endpoint, writeKey.token, 'initialize', initialize)).text()).result.instructions).toContain('mode: all');
}, 30000);

test('共享成员写入记忆，本机和共享均可召回；遗忘和撤销凭证立即生效', async () => {
  const call = async (url: string, token: string, name: string, args: unknown) => frame(await (await rpc(url, token, 'tools/call', { name, arguments: args })).text());
  const denied = await call(endpoint, readKey.token, 'remember', { fact: '只读凭证不能写入', provenance: 'test', visibility: 'world' });
  expect(Boolean(denied.error || denied.result?.isError)).toBe(true);
  const stored = await call(endpoint, writeKey.token, 'remember', { fact: '网络验收项目采用中文报告', kind: 'preference', provenance: 'memory network fixture', visibility: 'world' });
  expect(stored.error).toBeUndefined();
  expect(stored.result.isError).not.toBe(true);
  for (const url of [origin + '/mcp', endpoint]) {
    const recalled = await call(url, writeKey.token, 'recall', { grep: '网络验收项目' });
    expect(JSON.stringify(recalled.result)).toContain('网络验收项目采用中文报告');
  }
  const remembered = JSON.parse(stored.result.content.find((entry: any) => entry.type === 'text').text);
  const forgotten = await call(endpoint, writeKey.token, 'forget', { id: String(remembered.id) });
  expect(forgotten.result?.isError).not.toBe(true);
  const recalled = await call(endpoint, writeKey.token, 'recall', { grep: '网络验收项目' });
  expect(JSON.stringify(recalled.result)).not.toContain('网络验收项目采用中文报告');
  await admin('api-keys/revoke', { name: writeKey.name });
  expect((await rpc(endpoint, writeKey.token, 'initialize', initialize)).status).toBe(401);
  await gateway.stop();
  await expect(fetch(endpoint, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  expect((await rpc(origin + '/mcp', readKey.token, 'initialize', initialize)).ok).toBe(true);
}, 30000);
