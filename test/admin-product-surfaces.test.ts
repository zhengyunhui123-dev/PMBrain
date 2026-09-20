import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  googleConnectArgv,
  googleConnectNeedsPaste,
  parseGoogleConnectStdout,
  redactGoogleArgv,
  sanitizeGoogleConnectEnvelope,
} from '../src/core/creds/oauth-envelope.ts';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Admin product surfaces', () => {
  test('routes are thin wrappers over existing ops and google CLI', () => {
    const routes = read('src/commands/pmbrain-admin-routes.ts');
    const helper = read('src/commands/admin-product-surfaces.ts');
    expect(routes).toContain("app.get('/admin/api/connectors'");
    expect(routes).toContain("app.post('/admin/api/connectors/sync'");
    expect(routes).toContain("app.post('/admin/api/connectors/auth'");
    expect(routes).toContain("app.post('/admin/api/connectors/auto-sync'");
    expect(routes).toContain("app.get('/admin/api/waiting'");
    expect(routes).toContain("app.post('/admin/api/waiting/scan'");
    expect(routes).toContain("app.get('/admin/api/people'");
    expect(routes).toContain("app.get('/admin/api/chronicle/day'");
    expect(routes).toContain("app.get('/admin/api/chronicle/on-this-day'");
    expect(routes).toContain("app.get('/admin/api/ontology'");
    expect(routes).toContain("app.post('/admin/api/entity-identity/link'");
    expect(routes).toContain("app.post('/admin/api/google/connect'");
    expect(helper).toContain("handleToolCall(engine, name, params)");
    expect(helper).toContain("googleConnectArgv");
    expect(helper).not.toContain('startLoopback');
    expect(helper).not.toContain('exchangeCode');
    expect(helper).not.toContain('loop-detect');
    expect(helper).not.toContain('extract_facts');
  });

  test('面向用户的信息架构不再平铺底层能力', () => {
    const app = read('admin/src/App.tsx');
    const waiting = read('admin/src/pages/Waiting.tsx');
    const connectors = read('admin/src/pages/Connectors.tsx');
    expect(app).toContain("page: 'waiting', label: '待我处理'");
    expect(app).toContain("page: 'chronicle', label: '时间线'");
    expect(app).toContain("page: 'connectors', label: '数据连接'");
    expect(app).not.toContain("label: '人物关联'");
    expect(app).not.toContain("title: '日常'");
    expect(waiting).toContain('重新检查');
    expect(waiting).not.toContain('立即扫描');
    expect(waiting).not.toContain('你已清零');
    expect(waiting).not.toContain('Open Loop');
    expect(connectors).not.toContain('console.log');
    expect(connectors).not.toContain('startLoopback');
    expect(connectors).not.toContain('client_secret');
    expect(connectors).not.toContain('refresh_token');
    expect(connectors).toContain('打不开回跳页？改用粘贴网址');
    expect(connectors).toContain('高级设置');
  });
});

describe('Google connect envelope sanitizer', () => {
  test('strips authorization codes and tokens before UI sees them', () => {
    const envelope = sanitizeGoogleConnectEnvelope({
      ok: false,
      status: 'awaiting_consent',
      code: '4/secret-code',
      refresh_token: '1//secret',
      access_token: 'ya29.secret',
      client_secret: 'shhh',
      next_action: {
        command: 'pmbrain google connect --code "http://127.0.0.1:41999/?code=4/leak&state=abc"',
        user_message: 'Open http://127.0.0.1:41999/?code=4/leak&state=abc',
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('4/secret-code');
    expect(JSON.stringify(envelope)).not.toContain('1//secret');
    expect(JSON.stringify(envelope)).not.toContain('ya29.secret');
    expect(JSON.stringify(envelope)).not.toContain('shhh');
    expect(JSON.stringify(envelope)).not.toContain('4/leak');
    expect(envelope.next_action?.command).toContain('[redacted]');
    expect(googleConnectNeedsPaste(envelope)).toBe(true);
  });

  test('builds Sidecar argv and redacts --code in logs', () => {
    const argv = googleConnectArgv({ paste: true, code: 'http://127.0.0.1/?code=4/abc', clientJsonPath: 'C:\\client.json' });
    expect(argv).toEqual(['google', 'connect', '--json', '--client-json', 'C:\\client.json', '--paste', '--code', 'http://127.0.0.1/?code=4/abc']);
    expect(redactGoogleArgv(argv)).toContain('<redacted>');
    expect(redactGoogleArgv(argv)).not.toContain('4/abc');
    expect(parseGoogleConnectStdout('noise\n{"ok":true,"status":"connected"}\n')).toEqual({ ok: true, status: 'connected' });
  });
});
