import { loadActivePack } from '../schema-pack/load-active.ts';
import type { AdvisorCollector } from './types.ts';

export const collectSchemaPack: AdvisorCollector = {
  id: 'schema-pack',
  collect: async (ctx) => {
    let dbConfig: string | undefined;
    try {
      dbConfig = (await ctx.engine.getConfig('schema_pack')) ?? undefined;
    } catch {
      dbConfig = undefined;
    }
    try {
      await loadActivePack({ cfg: ctx.config, remote: false, dbConfig });
      return [];
    } catch (err) {
      const name = dbConfig ?? ctx.config?.schema_pack ?? '(configured)';
      return [{
        id: 'schema_pack_unresolved',
        severity: 'warn',
        title: `The configured schema pack "${name}" could not be resolved.`,
        detail: `${(err as Error).message}. Pick an installed pack or clear the override.`,
        fix: { command_argv: ['pmbrain', 'schema', 'packs'] },
        collector: 'schema-pack',
        ask_user: true,
      }];
    }
  },
};
