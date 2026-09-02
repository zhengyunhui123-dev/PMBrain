import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const MCP_CLIENT_WINDOW_DAYS = 30;
export const MCP_CLIENT_MIN_CALLS = 10;
export const MCP_CLIENT_MIN_FAILURES = 5;
export const MCP_CLIENT_FAILURE_RATE = 0.25;

interface McpClientHealthRow {
  client_id: string;
  client_name: string;
  total_calls: number | string;
  failed_calls: number | string;
  successful_calls: number | string;
  last_seen: unknown;
}

function count(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * PMBrain-compatible MCP client fit check.
 *
 * GBrain 0.47.5.0 right-sizes its newer per-client tool surfaces. PMBrain does
 * not yet have that surface contract, so suggesting `rescope-client` would be
 * non-runnable. This adapter keeps the useful, schema-compatible part for the
 * Work Desktop integrations: sustained request failure is a genuine client
 * mismatch and is visible in the existing mcp_request_log on both engines.
 */
export const collectMcpClientFit: AdvisorCollector = {
  id: 'mcp-client-fit',
  collect: async (ctx): Promise<AdvisorFinding[]> => {
    let rows: McpClientHealthRow[];
    try {
      rows = await ctx.engine.executeRaw<McpClientHealthRow>(
        `SELECT c.client_id,
                c.client_name,
                COUNT(l.id)::int AS total_calls,
                COALESCE(SUM(CASE WHEN l.status NOT IN ('success', 'success_with_warnings') THEN 1 ELSE 0 END), 0)::int AS failed_calls,
                COALESCE(SUM(CASE WHEN l.status IN ('success', 'success_with_warnings') THEN 1 ELSE 0 END), 0)::int AS successful_calls,
                MAX(l.created_at) AS last_seen
           FROM oauth_clients c
           JOIN mcp_request_log l
             ON l.token_name = c.client_id
            AND l.created_at > now() - ($1::int * interval '1 day')
          WHERE c.deleted_at IS NULL
          GROUP BY c.client_id, c.client_name`,
        [MCP_CLIENT_WINDOW_DAYS],
      );
    } catch {
      return [];
    }

    const unhealthy = rows.filter((row) => {
      const total = count(row.total_calls);
      const failures = count(row.failed_calls);
      return total >= MCP_CLIENT_MIN_CALLS
        && failures >= MCP_CLIENT_MIN_FAILURES
        && failures / total >= MCP_CLIENT_FAILURE_RATE;
    });
    if (unhealthy.length === 0) return [];

    if (ctx.remote) {
      return [{
        id: 'mcp_client_unhealthy_aggregate',
        severity: 'warn',
        title: `${unhealthy.length} MCP client${unhealthy.length === 1 ? '' : 's'} have sustained request failures.`,
        detail:
          `The last ${MCP_CLIENT_WINDOW_DAYS} days contain at least ${MCP_CLIENT_MIN_CALLS} requests and a ` +
          `${Math.round(MCP_CLIENT_FAILURE_RATE * 100)}% failure rate for each client. ` +
          'Run `pmbrain advisor` on the host to see client names; remote output redacts them.',
        fix: { command_argv: null },
        collector: 'mcp-client-fit',
        ask_user: true,
      }];
    }

    return unhealthy.map((row) => {
      const total = count(row.total_calls);
      const failures = count(row.failed_calls);
      const successes = count(row.successful_calls);
      const percent = Math.round((failures / total) * 100);
      return {
        id: `mcp_client_unhealthy:${row.client_id}`,
        severity: 'warn' as const,
        title: `MCP client "${row.client_name}" has a ${percent}% request failure rate (${failures}/${total}) over 30 days.`,
        detail:
          successes === 0
            ? 'No successful request was recorded. Re-run the integration health check and verify its URL, token/OAuth credentials, and allowed operations.'
            : 'Re-run the integration health check and inspect recent MCP errors before changing credentials or permissions.',
        fix: { command_argv: null },
        collector: 'mcp-client-fit',
        ask_user: true,
      };
    });
  },
};
