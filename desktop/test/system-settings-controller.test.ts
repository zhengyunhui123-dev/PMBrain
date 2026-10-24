import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pmbrain-connection-settings-'));
const previousHome = process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME = home;
mkdirSync(join(home, '.pmbrain'));
let response = 0;
let loginWrites = 0;
mock.module('electron', () => ({
  app: { isReady: () => true, isPackaged: false, getAppPath: () => home, getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings: () => { loginWrites++; } },
  dialog: { showMessageBox: async () => ({ response }) },
  nativeTheme: { themeSource: 'dark', shouldUseDarkColors: true },
}));

const { SystemSettingsController } = await import('../src/main/system/system-settings-controller');
const { getDesktopPreferences } = await import('../src/main/config-manager');
const candidate = { adapterName: 'Wi-Fi', address: '192.168.10.20', netmask: '255.255.255.0', cidr: '192.168.10.20/24', mac: '00:00:00:00:00:01', virtual: false, recommended: true };
const configPath = join(home, '.pmbrain', 'config.json');

beforeEach(() => {
  response = 0;
  loginWrites = 0;
  writeFileSync(configPath, JSON.stringify({ engine: 'pglite', desktop: { setup_completed: true, network_mode: 'local', theme: 'dark', close_behavior: 'quit', start_minimized: true } }));
});
afterAll(() => { if (previousHome === undefined) delete process.env.PMBRAIN_HOME; else process.env.PMBRAIN_HOME = previousHome; });

function fixture() {
  let restarts = 0;
  let updates = 0;
  let convergeError = false;
  const memory = { mode: 'off', enabled: false, ttl: '3d', notice_shown: true, visibility: 'world', agents: [], issues: [] };
  const lan: any = { status: null, warning: undefined, selectedAddressWasUnavailable: false, resetAfterSettingsSave: () => {}, reconcile: async () => {
    lan.status = getDesktopPreferences().networkMode === 'shared' ? { running: true, mcpUrl: 'http://192.168.10.20:3131/mcp' } : null;
    return lan.status;
  } };
  const controller = new SystemSettingsController({
    lan,
    sidecar: { current: { mcpUrl: 'http://127.0.0.1:3132/mcp', restart: async () => { restarts++; }, adminRequest: async (_path: string, options?: { body: string }) => {
      if (options) { const payload = JSON.parse(options.body); memory.mode = payload.mode ?? memory.mode; memory.enabled = memory.mode !== 'off'; updates++; }
      return { ...memory };
    } } } as any,
    getMainWindow: () => ({ webContents: { send: () => {} } }) as any,
    refreshTray: () => {},
    convergeMemoryRules: async () => { if (convergeError) throw new Error('WorkBuddy 托管文件有用户修改，未覆盖'); },
    listNetworkCandidates: () => [candidate],
  });
  return { controller, lan, counts: () => ({ restarts, updates }), failConvergence: () => { convergeError = true; } };
}

test('长期记忆立即写入，不需要外部客户端，不重启对话和后台服务', async () => {
  const f = fixture();
  for (const mode of ['salient', 'all', 'off'] as const) {
    expect((await f.controller.saveMemoryWriteback({ mode, notice_shown: true })).mode).toBe(mode);
    expect((await f.controller.memoryWriteback()).enabled).toBe(mode !== 'off');
  }
  expect(f.counts()).toEqual({ restarts: 0, updates: 3 });
});

test('外部托管文件冲突明确反馈，已保存的记忆开关和本地服务保留', async () => {
  const f = fixture();
  f.failConvergence();
  await expect(f.controller.saveMemoryWriteback({ mode: 'all' })).rejects.toThrow('未覆盖');
  expect((await f.controller.memoryWriteback()).mode).toBe('all');
  expect(f.counts().restarts).toBe(0);
});

test('网络选择独立保存，确认后启动共享，取消回到实际状态，关闭共享保留其他偏好', async () => {
  const f = fixture();
  const input = { networkMode: 'shared' as const, sharedAdapter: candidate.adapterName, sharedIp: candidate.address };
  response = 1;
  expect((await f.controller.save(input)).canceled).toBe(true);
  expect(getDesktopPreferences().networkMode).toBe('local');
  response = 0;
  expect((await f.controller.save(input)).state.gateway?.running).toBe(true);
  expect((await f.controller.save({ networkMode: 'local' })).state.gateway).toBeNull();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.desktop.theme).toBe('dark');
  expect(config.desktop.close_behavior).toBe('quit');
  expect(config.desktop.start_minimized).toBe(true);
  expect(loginWrites).toBe(0);
  expect(f.counts().restarts).toBe(0);
});

test('不可用地址不会被保存，也不会静默切换网卡', async () => {
  const f = fixture();
  await expect(f.controller.save({ networkMode: 'shared', sharedAdapter: 'other', sharedIp: candidate.address })).rejects.toThrow('当前不可用');
  expect(getDesktopPreferences().networkMode).toBe('local');
  expect(f.lan.status).toBeNull();
});
