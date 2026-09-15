import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('request log business-call view', () => {
  const page = readFileSync('admin/src/pages/RequestLog.tsx', 'utf8');
  const server = readFileSync('src/commands/serve-http.ts', 'utf8');

  test('shows real MCP tool names by default and keeps an all-request view', () => {
    expect(page).toContain("useState<'business' | 'all'>('business')");
    expect(page).toContain('业务调用');
    expect(page).toContain('全部请求');
    expect(page).toContain('kind=${requestKind}');
  });

  test('filters protocol discovery on the server without deleting audit rows', () => {
    expect(server).toContain("req.query.kind === 'business'");
    expect(server).toContain("operation <> 'tools/list'");
    expect(server).toContain("operation <> 'initialize'");
    expect(server).toContain("operation <> 'notifications/initialized'");
    expect(server).toContain("operation <> 'ping'");
    expect(server).toContain("[authInfo.clientId, agentName, 'tools/list'");
  });
});
