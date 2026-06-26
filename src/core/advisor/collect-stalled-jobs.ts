import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const collectStalledJobs: AdvisorCollector = {
  id: 'stalled-jobs',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    try {
      const rows = await ctx.engine.executeRaw<{ name: string; n: number }>(
        `SELECT name, count(*)::int AS n
           FROM minion_jobs
          WHERE status = 'active'
            AND (lock_until < now() OR stalled_counter >= 2)
          GROUP BY name
          ORDER BY n DESC`,
      );
      for (const r of rows) {
        findings.push({
          id: `stalled_job:${r.name}`,
          severity: 'warn',
          title: `${r.n} "${r.name}" job${r.n === 1 ? '' : 's'} look stalled.`,
          detail: 'A wedged worker can stop backfill or sync progress.',
          fix: { command_argv: ['pmbrain', 'jobs', 'status'] },
          collector: 'stalled-jobs',
          ask_user: true,
        });
      }
    } catch {
      // Old schemas or test engines may not have minion_jobs.
    }

    try {
      const rows = await ctx.engine.executeRaw<{ id: string }>(
        `SELECT id
           FROM sources
          WHERE last_sync_at IS NOT NULL
            AND last_sync_at < now() - interval '7 days'
          ORDER BY id`,
      );
      for (const r of rows) {
        findings.push({
          id: `stale_sync:${r.id}`,
          severity: 'info',
          title: `Source "${r.id}" has not synced in over a week.`,
          detail: 'Re-sync to pull in content PMBrain has not indexed yet.',
          fix: { command_argv: ['pmbrain', 'sync', '--source', r.id] },
          collector: 'stalled-jobs',
          ask_user: true,
        });
      }
    } catch {
      // Very old schemas may not have sources.last_sync_at.
    }

    return findings;
  },
};
