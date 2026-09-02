import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectMcpClientFit } from '../src/core/advisor/collect-mcp-client-fit.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO oauth_clients (client_id, client_name) VALUES ($1, $2)`,
    ['advisor-pglite-client', 'Advisor PGLite Client'],
  );
  for (let index = 0; index < 12; index++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, operation, status) VALUES ($1, $2, $3)`,
      ['advisor-pglite-client', 'search', index < 5 ? 'success' : 'error'],
    );
  }
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('Advisor MCP client fit on real PGLite', () => {
  test('uses the shared OAuth/request-log schema without engine-specific SQL', async () => {
    const findings = await collectMcpClientFit.collect({
      engine,
      config: { engine: 'pglite' },
      version: 'test',
      workspace: null,
      skillsDir: null,
      now: new Date(),
      remote: false,
    } as AdvisorContext);
    expect(findings.map((finding) => finding.id)).toContain('mcp_client_unhealthy:advisor-pglite-client');
  });
});
