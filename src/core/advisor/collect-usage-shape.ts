import { isEmbeddingConfigured } from '../embedding-dim-check.ts';
import { loadOrphanPolicyOverrides, shouldExcludeFromOrphanReporting } from '../orphan-policy.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

async function countPendingChunks(ctx: { engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> } }): Promise<number | null> {
  try {
    const rows = await ctx.engine.executeRaw<{ pending: number }>(
      `SELECT COUNT(*)::int AS pending
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE c.embedding IS NULL
          AND p.deleted_at IS NULL`,
    );
    return Number(rows[0]?.pending ?? 0);
  } catch {
    return null;
  }
}

export const collectUsageShape: AdvisorCollector = {
  id: 'usage-shape',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];
    let pageCount = 0;
    try {
      const stats = await ctx.engine.getStats();
      pageCount = stats.page_count;
    } catch {
      return [];
    }
    if (pageCount === 0) return [];

    const embeddingOn = isEmbeddingConfigured(ctx.config);
    let embedCoverage: number | null = null;
    let missingFromHealth: number | null = null;
    let deadLinks = 0;
    try {
      const health = await ctx.engine.getHealth();
      embedCoverage = health.embed_coverage;
      missingFromHealth = health.missing_embeddings;
      deadLinks = health.dead_links;
    } catch {
      /* getHealth unavailable → skip coverage-derived findings */
    }

    if (embeddingOn) {
      const pending = (await countPendingChunks(ctx)) ?? missingFromHealth ?? 0;
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

    try {
      const overrides = await loadOrphanPolicyOverrides(ctx.engine);
      const rows = await ctx.engine.findOrphanPages();
      const orphanCount = rows.filter((row) => !shouldExcludeFromOrphanReporting(row.slug, overrides)).length;
      if (orphanCount > 0) {
        findings.push({
          id: 'orphan_pages',
          severity: 'info',
          title: `${orphanCount} knowledge pages have no links in or out.`,
          detail: 'Orphaned pages do not surface through graph traversal.',
          fix: { command_argv: ['pmbrain', 'dream', '--phase', 'orphans'], dispatch_id: 'organize_orphans' },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
    } catch {
      /* orphan scan unavailable */
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
