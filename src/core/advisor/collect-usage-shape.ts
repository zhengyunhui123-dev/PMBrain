import type { AdvisorCollector, AdvisorFinding } from './types.ts';

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

    try {
      const health = await ctx.engine.getHealth();
      if (health.embed_coverage < 0.7 && health.missing_embeddings > 0) {
        findings.push({
          id: 'low_embed_coverage',
          severity: 'warn',
          title: `Only ${Math.round(health.embed_coverage * 100)}% of content is embedded.`,
          detail: `${health.missing_embeddings} pages are missing embeddings. Backfill to restore full recall.`,
          fix: { command_argv: ['pmbrain', 'embed', '--all'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
      if (health.orphan_pages > 0) {
        findings.push({
          id: 'orphan_pages',
          severity: 'info',
          title: `${health.orphan_pages} page${health.orphan_pages === 1 ? ' has' : 's have'} no links in or out.`,
          detail: 'Orphaned pages do not surface through graph traversal.',
          fix: { command_argv: ['pmbrain', 'orphans'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
      if (health.dead_links > 0) {
        findings.push({
          id: 'dead_links',
          severity: 'info',
          title: `${health.dead_links} link${health.dead_links === 1 ? '' : 's'} point to missing pages.`,
          fix: { command_argv: ['pmbrain', 'doctor'] },
          collector: 'usage-shape',
          ask_user: true,
        });
      }
    } catch {
      // Keep the advisor alive if the heavier health probe fails.
    }

    return findings;
  },
};
