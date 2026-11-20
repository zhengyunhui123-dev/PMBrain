import { isValidSourceId } from '../source-id.ts';
import type { AdvisorCollector, AdvisorContext, AdvisorFinding, AdvisorMaintenance } from './types.ts';

export const collectStalledJobs: AdvisorCollector = {
  id: 'stalled-jobs',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    if (ctx.engine.kind === 'pglite' && !ctx.remote) {
      await ctx.engine.executeRaw(
        `UPDATE minion_jobs
            SET status = 'dead',
                error_text = COALESCE(NULLIF(error_text, ''), 'owner process exited'),
                lock_token = NULL,
                lock_until = NULL,
                finished_at = COALESCE(finished_at, now()),
                updated_at = now()
          WHERE status = 'active'
            AND (lock_until IS NULL OR lock_until < now())`,
      );
    }
    const jobs = await ctx.engine.executeRaw<{ name: string; n: number }>(
      `SELECT name, count(*)::int AS n
         FROM minion_jobs
        WHERE status = 'active'
          AND (lock_until < now() OR stalled_counter >= 2)
        GROUP BY name
        ORDER BY n DESC`,
    );
    for (const r of jobs) {
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

    try {
      const rows = await ctx.engine.executeRaw<{ id: string; last_sync_at: string }>(
        `SELECT id, last_sync_at::text AS last_sync_at
           FROM sources
          WHERE last_sync_at IS NOT NULL
            AND last_sync_at < now() - interval '7 days'
            AND COALESCE(archived, false) = false
          ORDER BY id`,
      );
      for (const r of rows) pushStaleSync(findings, r.id, r.last_sync_at, ctx.now);
    } catch {
      const rows = await ctx.engine.executeRaw<{ id: string }>(
        `SELECT id
           FROM sources
          WHERE last_sync_at IS NOT NULL
            AND last_sync_at < now() - interval '7 days'
          ORDER BY id`,
      );
      for (const r of rows) pushStaleSync(findings, r.id, null, ctx.now);
    }

    return findings;
  },
};

function pushStaleSync(findings: AdvisorFinding[], id: string, lastSyncAt: string | null, now: Date): void {
  if (!isValidSourceId(id)) return;
  const syncedAt = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
  const days = Number.isFinite(syncedAt) ? Math.max(7, Math.floor((now.getTime() - syncedAt) / 86_400_000)) : 7;
  findings.push({
    id: `stale_sync:${id}`,
    severity: 'info',
    title: `Source "${id}" has not synced in ${days} days.`,
    detail: 'Re-sync to pull in content PMBrain has not indexed yet.',
    fix: { command_argv: ['pmbrain', 'sync', '--source', id], dispatch_id: `sync_source:${id}` },
    collector: 'stalled-jobs',
    ask_user: true,
  });
}

const ACTIVE_ORGANIZE = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'paused']);
const FAILED_ORGANIZE = new Set(['failed', 'dead', 'cancelled']);

export async function readMaintenanceStatus(ctx: AdvisorContext): Promise<AdvisorMaintenance> {
  const sources = await ctx.engine.executeRaw<{ local_path: string | null; last_sync_at: string | null }>(
    `SELECT local_path, last_sync_at::text AS last_sync_at
       FROM sources
      WHERE COALESCE(archived, false) = false`,
  ).catch(() => ctx.engine.executeRaw<{ local_path: string | null; last_sync_at: string | null }>(
    `SELECT local_path, last_sync_at::text AS last_sync_at FROM sources`,
  ));
  const cutoff = ctx.now.getTime() - 7 * 86_400_000;
  const pending = sources.some(row => {
    if (!row.last_sync_at) return Boolean(row.local_path);
    const syncedAt = Date.parse(row.last_sync_at);
    return Number.isFinite(syncedAt) && syncedAt < cutoff;
  });
  const synced = sources.some(row => Boolean(row.last_sync_at));
  const jobs = await ctx.engine.executeRaw<{ status: string }>(
    `SELECT status
       FROM minion_jobs
      WHERE data->'task'->>'type' = 'dream'
        AND COALESCE(data->'task'->'input'->>'preset', '') <> 'quick'
        AND COALESCE(data->'task'->'input'->>'dryRun', '') IS DISTINCT FROM 'true'
      ORDER BY COALESCE(finished_at, updated_at) DESC
      LIMIT 1`,
  );
  const status = jobs[0]?.status ?? '';
  const organize = ACTIVE_ORGANIZE.has(status)
    ? 'running'
    : status === 'completed'
      ? 'completed'
      : FAILED_ORGANIZE.has(status)
        ? 'failed'
        : 'none';
  return {
    sync: pending ? 'pending' : synced ? 'current' : 'none',
    organize,
  };
}
