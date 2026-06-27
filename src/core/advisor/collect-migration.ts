import { hasPendingMigrations } from '../migrate.ts';
import type { AdvisorCollector } from './types.ts';

export const collectMigration: AdvisorCollector = {
  id: 'migration',
  collect: async (ctx) => {
    let pending = false;
    try {
      pending = await hasPendingMigrations(ctx.engine);
    } catch {
      return [];
    }
    if (!pending) return [];
    return [{
      id: 'pending_migration',
      severity: 'critical',
      title: 'Schema migrations are pending.',
      detail: 'Newer PMBrain code expects the latest schema. Run migrations before relying on newer features.',
      fix: { command_argv: ['pmbrain', 'apply-migrations', '--yes'] },
      collector: 'migration',
      ask_user: true,
    }];
  },
};
