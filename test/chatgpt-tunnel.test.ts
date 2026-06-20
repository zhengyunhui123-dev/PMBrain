import { describe, expect, test } from 'bun:test';
import { buildChatGptTunnelProfile, parseTunnelId } from '../src/core/chatgpt-tunnel.ts';
import { legacyAccessTokenScopes } from '../src/core/oauth-provider.ts';
import { filterMcpOperationsByScopes, isLoopbackAddress } from '../src/commands/serve-http.ts';

describe('ChatGPT Secure MCP Tunnel', () => {
  test('legacy keys keep full access unless scopes are explicit', () => {
    expect(legacyAccessTokenScopes(undefined)).toEqual(['read', 'write', 'admin']);
    expect(legacyAccessTokenScopes({ takes_holders: ['world'] })).toEqual(['read', 'write', 'admin']);
    expect(legacyAccessTokenScopes({ scopes: ['read'] })).toEqual(['read']);
    expect(legacyAccessTokenScopes({ scopes: ['read', 'unknown'] })).toEqual(['read', 'write', 'admin']);
  });

  test('read-only clients only discover read tools', () => {
    const operations = [
      { name: 'search', scope: 'read' },
      { name: 'put_page', scope: 'write' },
      { name: 'schema_apply', scope: 'admin' },
    ];
    expect(filterMcpOperationsByScopes(operations, ['read']).map(op => op.name)).toEqual(['search']);
    expect(filterMcpOperationsByScopes(operations, ['write']).map(op => op.name)).toEqual(['search', 'put_page']);
  });

  test('tunnel administration is restricted to loopback sessions', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
  });

  test('generated profile keeps both control-plane and MCP secrets as file references', () => {
    const profile = buildChatGptTunnelProfile({
      tunnelId: 'tunnel_example123',
      mcpUrl: 'http://127.0.0.1:3132/mcp',
      runtimeKeyFile: 'C:\\Users\\alice\\.pmbrain\\runtime.key',
      authorizationHeaderFile: 'C:\\Users\\alice\\.pmbrain\\authorization.header',
    });
    expect(profile).toContain('api_key: "file:C:/Users/alice/.pmbrain/runtime.key"');
    expect(profile).toContain('Authorization: file:C:/Users/alice/.pmbrain/authorization.header');
    expect(profile).toContain('discovery_extra_headers:');
    expect(profile).not.toContain('sk-');
    expect(profile).not.toContain('Bearer pmbrain_');
    expect(parseTunnelId(profile)).toBe('tunnel_example123');
  });
});
