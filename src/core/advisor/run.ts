import type { AdvisorCollector, AdvisorContext, AdvisorFinding, AdvisorReport, AdvisorSeverity } from './types.ts';
import { collectVersion } from './collect-version.ts';
import { collectMigration } from './collect-migration.ts';
import { collectSchemaPack } from './collect-schema-pack.ts';
import { collectStalledJobs } from './collect-stalled-jobs.ts';
import { collectUsageShape } from './collect-usage-shape.ts';
import { collectSetupSmells } from './collect-setup-smells.ts';
import { collectUninstalledBundled } from './collect-uninstalled-bundled.ts';
import { collectMcpClientFit } from './collect-mcp-client-fit.ts';
import { collectBackupCoverage } from './collect-backup-coverage.ts';

export const COLLECTORS: AdvisorCollector[] = [
  collectVersion,
  collectMigration,
  collectSchemaPack,
  collectStalledJobs,
  collectUsageShape,
  collectSetupSmells,
  collectUninstalledBundled,
  collectMcpClientFit,
  collectBackupCoverage,
];

const SEV_RANK: Record<AdvisorSeverity, number> = { critical: 0, warn: 1, info: 2 };

export function rankFindings(findings: AdvisorFinding[], opts: { infoCap?: number } = {}): AdvisorFinding[] {
  const order = new Map(COLLECTORS.map((c, i) => [c.id, i] as const));
  const sorted = [...findings].sort((a, b) => {
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (s !== 0) return s;
    return (order.get(a.collector) ?? 99) - (order.get(b.collector) ?? 99);
  });
  const out: AdvisorFinding[] = [];
  let infoSeen = 0;
  for (const f of sorted) {
    if (f.severity === 'info') {
      if (infoSeen >= (opts.infoCap ?? 10)) continue;
      infoSeen++;
    }
    out.push(f);
  }
  return out;
}

export async function runAdvisor(ctx: AdvisorContext): Promise<AdvisorReport> {
  const all: AdvisorFinding[] = [];
  for (const c of COLLECTORS) {
    try {
      const found = await c.collect(ctx);
      for (const f of found) {
        if (ctx.remote && f.workspace_dependent) continue;
        all.push(f);
      }
    } catch {
      // One collector failing must not kill the report.
    }
  }
  const findings = rankFindings(all);
  const worst: AdvisorSeverity | null =
    findings.some((f) => f.severity === 'critical') ? 'critical'
      : findings.some((f) => f.severity === 'warn') ? 'warn'
        : findings.length > 0 ? 'info'
          : null;
  return { version: ctx.version, generated_at: ctx.now.toISOString(), findings, worst };
}
