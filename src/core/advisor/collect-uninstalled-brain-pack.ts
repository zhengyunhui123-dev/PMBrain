import { existsSync } from 'fs';
import { join } from 'path';

import { loadAllSources, parseSourceConfig } from '../sources-load.ts';
import { loadSkillpackManifest } from '../skillpack/manifest-v1.ts';
import { loadState, findEntry } from '../skillpack/state.ts';
import { loadNagState, findNag, decideNagAction } from '../skillpack/nag-state.ts';
import { deriveBrainId } from '../skillpack/brain-resident-locate.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export const collectUninstalledBrainPack: AdvisorCollector = {
  id: 'uninstalled-brain-pack',
  collect: async (ctx) => {
    if (ctx.remote) return [];
    const findings: AdvisorFinding[] = [];

    let sources;
    try {
      sources = await loadAllSources(ctx.engine);
    } catch {
      return [];
    }
    const state = loadState();
    const nag = loadNagState();

    for (const src of sources) {
      const localPath = src.local_path;
      if (!localPath || !existsSync(join(localPath, 'skillpack.json'))) continue;
      try {
        const manifest = loadSkillpackManifest(localPath);
        if (manifest.brain_resident !== true) continue;

        const entry = findEntry(state, manifest.name);
        const installed = !!entry && entry.version === manifest.version;
        if (installed) continue;

        const remoteUrl = parseSourceConfig(src.config).remote_url as string | undefined;
        const brainId = deriveBrainId(remoteUrl ?? null, localPath);
        const decision = decideNagAction(
          findNag(nag, { brain_id: brainId, source_id: src.id, pack_name: manifest.name }),
          { pack_version: manifest.version },
        );
        if (!decision.show) continue;

        findings.push({
          id: `uninstalled_brain_pack:${src.id}:${manifest.name}`,
          severity: 'info',
          title: `Brain source "${src.id}" ships ${manifest.skills.length} skill${manifest.skills.length === 1 ? '' : 's'} you haven't installed (${manifest.name}).`,
          detail: 'These skills were authored for this brain. Install them to get its full operating manual.',
          fix: { command_argv: ['pmbrain', 'skillpack', 'scaffold', localPath] },
          collector: 'uninstalled-brain-pack',
          ask_user: true,
          workspace_dependent: true,
        });
      } catch {
        continue;
      }
    }
    return findings;
  },
};
