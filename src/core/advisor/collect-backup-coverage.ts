import { existsSync } from 'node:fs';
import {
  listPgliteUpgradeBackups,
  resolvePgliteUpgradeBackupRoot,
} from '../pglite-upgrade-backup.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

/** A monthly reminder matches GBrain's backup-coverage cadence. */
export const BACKUP_STALE_AFTER_DAYS = 30;

function ageDays(now: Date, createdAt: string): number | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  return Math.max(0, Math.floor((now.getTime() - created) / (24 * 60 * 60 * 1000)));
}

/**
 * PMBrain adapter for GBrain's backup-coverage collector.
 *
 * PMBrain's recoverable local database artifact is the verified PGLite cold
 * backup, so this collector intentionally reuses that manifest reader instead
 * of copying GBrain's git-workspace backup model. It never opens, copies,
 * restores, prunes, or modifies the active database or any backup.
 */
export const collectBackupCoverage: AdvisorCollector = {
  id: 'backup-coverage',
  collect: async (ctx): Promise<AdvisorFinding[]> => {
    if (ctx.config.engine !== 'pglite' || !ctx.config.database_path) return [];
    if (!existsSync(ctx.config.database_path)) return [];

    try {
      const stats = await ctx.engine.getStats();
      if ((stats.page_count ?? 0) <= 0) return [];

      const backupRoot = resolvePgliteUpgradeBackupRoot(ctx.config.pglite_upgrade_backup_dir);
      const backups = listPgliteUpgradeBackups(backupRoot, ctx.config.database_path);
      if (backups.length === 0) {
        return [{
          id: 'backup_pglite_missing',
          severity: 'warn',
          title: 'This populated PGLite brain has no verified recovery backup.',
          detail:
            'Create a verified cold backup before the next upgrade or disk failure. ' +
            'The check is read-only and does not expose database or backup paths.',
          fix: {
            command_argv: ['pmbrain', 'pglite-backup', 'create', '--target-version', ctx.version],
          },
          collector: 'backup-coverage',
          ask_user: true,
        }];
      }

      const latestAge = ageDays(ctx.now, backups[0]!.manifest.created_at);
      if (latestAge !== null && latestAge > BACKUP_STALE_AFTER_DAYS) {
        return [{
          id: 'backup_pglite_stale',
          severity: 'warn',
          title: `The latest verified PGLite recovery backup is ${latestAge} days old.`,
          detail:
            `Backup coverage is checked on a ${BACKUP_STALE_AFTER_DAYS}-day cadence. ` +
            'Create a new verified backup so recent knowledge can be recovered.',
          fix: {
            command_argv: ['pmbrain', 'pglite-backup', 'create', '--target-version', ctx.version],
          },
          collector: 'backup-coverage',
          ask_user: true,
        }];
      }
      return [];
    } catch {
      // Advisor is best-effort: an unreadable backup root or legacy engine
      // must not fabricate "missing backup" or break the rest of the report.
      return [];
    }
  },
};
