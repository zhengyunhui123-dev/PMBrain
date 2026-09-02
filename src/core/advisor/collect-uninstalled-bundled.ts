import { detectInstalledSlugs } from '../skillpack/post-install-advisory.ts';
import { currentRecommendedSet } from './recommended-set.ts';
import type { AdvisorCollector } from './types.ts';

/** Recurring counterpart to the one-shot post-install skill advisory. */
export const collectUninstalledBundled: AdvisorCollector = {
  id: 'uninstalled-bundled',
  collect: async (ctx) => {
    if (ctx.remote || !ctx.workspace || !ctx.skillsDir) return [];
    try {
      const installed = detectInstalledSlugs(ctx.skillsDir, ctx.workspace);
      const missing = currentRecommendedSet().filter((skill) => !installed.has(skill.slug));
      if (missing.length === 0) return [];
      return [{
        id: 'uninstalled_bundled_skills',
        severity: 'info' as const,
        title: `${missing.length} recommended skill${missing.length === 1 ? ' is' : 's are'} not installed in this workspace.`,
        detail: missing.map((skill) => skill.slug).join(', '),
        fix: { command_argv: ['pmbrain', 'skillpack', 'install', ...missing.map((skill) => skill.slug)] },
        collector: 'uninstalled-bundled',
        ask_user: true,
        workspace_dependent: true,
      }];
    } catch {
      return [];
    }
  },
};
