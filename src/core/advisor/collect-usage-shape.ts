import { isEmbeddingConfigured } from '../embedding-dim-check.ts';
import { loadOrphanPolicyOverrides, shouldExcludeFromOrphanReporting } from '../orphan-policy.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

async function countPendingChunks(ctx: { engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> } }): Promise<number> {
  const rows = await ctx.engine.executeRaw<{ pending: number }>(
    `SELECT COUNT(*)::int AS pending
       FROM content_chunks c
       JOIN pages p ON p.id = c.page_id
      WHERE c.embedding IS NULL
        AND p.deleted_at IS NULL`,
  );
  return Number(rows[0]?.pending ?? 0);
}

export const collectUsageShape: AdvisorCollector = {
  id: 'usage-shape',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];
    const stats = await ctx.engine.getStats();
    const pageCount = stats.page_count;
    if (pageCount === 0) return [];

    const embeddingOn = isEmbeddingConfigured(ctx.config);
    const health = await ctx.engine.getHealth();
    const embedCoverage = health.embed_coverage;
    const deadLinks = health.dead_links;

    if (embeddingOn) {
      const pending = await countPendingChunks(ctx);
      if (pending > 0) {
        const coveragePct = embedCoverage == null ? null : Math.round(embedCoverage * 100);
        findings.push({
          id: 'low_embed_coverage',
          severity: embedCoverage != null && embedCoverage < 0.7 ? 'warn' : 'info',
          title: `${pending} chunks are missing embeddings.`,
          detail: coveragePct == null
            ? 'Backfill stale chunks to restore semantic recall.'
            : `Coverage is ${coveragePct}%. Backfill stale chunks to restore semantic recall.`,
          fix: { command_argv: ['pmbrain', 'embed', '--stale'], dispatch_id: 'embed_stale' },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
    }

    const overrides = await loadOrphanPolicyOverrides(ctx.engine);
    const rows = await ctx.engine.findOrphanPages();
    const orphanCount = rows.filter((row) => !shouldExcludeFromOrphanReporting(row.slug, overrides)).length;
    if (orphanCount > 0) {
      findings.push({
        id: 'orphan_pages',
        severity: 'info',
        title: `${orphanCount} knowledge pages have no links in or out.`,
        detail: 'Orphaned pages do not surface through graph traversal — connect or review them.',
        fix: { command_argv: ['pmbrain', 'orphans'] },
        collector: 'usage-shape',
        ask_user: true,
      });
    }

    if (deadLinks > 0) {
      findings.push({
        id: 'dead_links',
        severity: 'info',
        title: `${deadLinks} link${deadLinks === 1 ? '' : 's'} point to missing pages.`,
        fix: { command_argv: ['pmbrain', 'doctor'] },
        collector: 'usage-shape',
        ask_user: true,
      });
    }

    return findings;
  },
};
