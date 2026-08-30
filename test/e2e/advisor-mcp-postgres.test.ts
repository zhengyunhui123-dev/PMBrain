import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { collectMcpClientFit } from '../../src/core/advisor/collect-mcp-client-fit.ts';
import type { AdvisorContext } from '../../src/core/advisor/types.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const suite = RUN ? describe : describe.skip;
const CLIENT_ID = 'advisor-postgres-client';

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  await engine.executeRaw(`DELETE FROM mcp_request_log WHERE token_name = $1`, [CLIENT_ID]);
  await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = $1`, [CLIENT_ID]);
  await engine.executeRaw(
    `INSERT INTO oauth_clients (client_id, client_name) VALUES ($1, $2)`,
    [CLIENT_ID, 'Advisor Postgres Client'],
  );
  for (let index = 0; index < 12; index++) {
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, operation, status) VALUES ($1, $2, $3)`,
      [CLIENT_ID, 'search', index < 5 ? 'success' : 'error'],
    );
  }
});

afterAll(async () => {
  if (!RUN) return;
  const engine = getEngine();
  await engine.executeRaw(`DELETE FROM mcp_request_log WHERE token_name = $1`, [CLIENT_ID]);
  await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = $1`, [CLIENT_ID]);
  await teardownDB();
});

suite('Advisor MCP client fit on real Postgres', () => {
  test('matches PGLite behavior', async () => {
    const findings = await collectMcpClientFit.collect({
      engine: getEngine(),
      config: { engine: 'postgres' },
      version: 'test',
      workspace: null,
      skillsDir: null,
      now: new Date(),
      remote: false,
    } as AdvisorContext);
    expect(findings.map((finding) => finding.id)).toContain(`mcp_client_unhealthy:${CLIENT_ID}`);
  });
});
