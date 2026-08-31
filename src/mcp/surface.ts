import type { Operation } from '../core/operations.ts';
import type { GBrainConfig } from '../core/config.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../core/minions/tools/brain-allowlist.ts';

export type McpSurface = 'verbs' | 'starter' | 'full';

const RANK: Record<McpSurface, number> = { verbs: 0, starter: 1, full: 2 };

export function isMcpSurface(value: unknown): value is McpSurface {
  return value === 'verbs' || value === 'starter' || value === 'full';
}

export function parseSurfaceFlag(args: string[]): McpSurface | null {
  const index = args.indexOf('--surface');
  if (index < 0) return null;
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error('--surface requires a value: verbs | starter | full');
  }
  if (!isMcpSurface(raw)) {
    throw new Error(`Unknown --surface "${raw}". Use: verbs | starter | full`);
  }
  return raw;
}

export function resolveSurface(
  flag: McpSurface | null,
  config: Pick<GBrainConfig, 'mcp_surface'> | null | undefined,
): McpSurface {
  if (flag) return flag;
  return isMcpSurface(config?.mcp_surface) ? config.mcp_surface : 'full';
}

export function minSurface(a: McpSurface, b: McpSurface): McpSurface {
  return RANK[a] <= RANK[b] ? a : b;
}

export function surfaceWiderThan(a: McpSurface, b: McpSurface): boolean {
  return RANK[a] > RANK[b];
}

export const STARTER_OPS: ReadonlySet<string> = new Set([
  ...BRAIN_TOOL_ALLOWLIST,
  'recall', 'remember', 'entity', 'forget', 'context_pack', 'delta',
  'whoami', 'request_tools', 'submit_agent', 'get_job',
]);

export function filterOpsForSurface(ops: Operation[], surface: McpSurface): Operation[] {
  if (surface === 'full') return ops;
  if (surface === 'verbs') return ops.filter((op) => op.verb === true);
  return ops.filter((op) => STARTER_OPS.has(op.name));
}

export function clampSurface(surface: McpSurface): McpSurface {
  const forced = process.env.PMBRAIN_MCP_FORCE_SURFACE ?? process.env.GBRAIN_MCP_FORCE_SURFACE;
  return isMcpSurface(forced) ? minSurface(surface, forced) : surface;
}

export function effectiveSurfaceForClient(opts: {
  ceiling: McpSurface;
  clientSurface?: unknown;
  defaultSurface?: unknown;
}): McpSurface {
  const ceiling = clampSurface(opts.ceiling);
  const requested = isMcpSurface(opts.clientSurface)
    ? opts.clientSurface
    : isMcpSurface(opts.defaultSurface) ? opts.defaultSurface : ceiling;
  return minSurface(ceiling, requested);
}
