import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { HOST_BRAIN_ID } from '../brain-registry.ts';

export const BRAIN_AUDIENCE_KEY = 'brain.audience';
export const SHARED_CLIENT_THRESHOLD = 3;

export type BrainAudience = 'personal' | 'shared' | 'unknown';
export interface BrainAudienceResult {
  audience: BrainAudience;
  reasons: string[];
}

export async function classifyBrainAudience(
  engine: BrainEngine,
  fileCfg?: GBrainConfig | null,
): Promise<BrainAudienceResult> {
  let declared: string | null;
  try {
    let fileDeclared: string | null = null;
    try {
      if (resolveBrainId(undefined) === HOST_BRAIN_ID) {
        fileDeclared = fileCfg?.brain?.audience ?? null;
      }
    } catch { /* mount resolution failed — the mirror is not this brain's voice */ }
    declared = (await engine.getConfig(BRAIN_AUDIENCE_KEY)) ?? fileDeclared;
  } catch {
    return { audience: 'unknown', reasons: ['brain.audience unreadable (config read failed)'] };
  }
  const d = declared == null ? '' : declared.trim().toLowerCase();
  if (d === 'shared') return { audience: 'shared', reasons: ['declared: brain.audience=shared'] };
  if (d === 'personal') return { audience: 'personal', reasons: ['declared: brain.audience=personal'] };
  const reasons: string[] = [];
  if (d) reasons.push(`brain.audience='${d}' unrecognized (expected personal|shared) — falling back to the heuristic`);

  try {
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(DISTINCT token_name)::int AS n
         FROM mcp_request_log
        WHERE created_at > now() - interval '30 days'
          AND token_name IS NOT NULL
          AND status IN ('success', 'success_with_warnings')`,
    );
    const humans = Number(rows[0]?.n ?? 0);
    if (humans >= SHARED_CLIENT_THRESHOLD) {
      return {
        audience: 'shared',
        reasons: [
          ...reasons,
          `heuristic: ${humans} distinct MCP clients active in 30d (threshold ${SHARED_CLIENT_THRESHOLD}) — declare the truth with: pmbrain config set brain.audience personal|shared`,
        ],
      };
    }
    return {
      audience: 'personal',
      reasons: [...reasons, `no shared declaration; ${humans} distinct client(s) active in 30d`],
    };
  } catch {
    return { audience: 'personal', reasons: [...reasons, 'no shared declaration; client-usage heuristic unavailable'] };
  }
}
