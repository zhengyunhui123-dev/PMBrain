import type { AdvisorCollector } from './types.ts';
import { AUTO_WRITEBACK_KEY, AUTO_WRITEBACK_NOTICE_KEY } from '../facts/writeback-config.ts';
import { classifyBrainAudience } from '../facts/writeback-audience.ts';
import { isThinClient } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { HOST_BRAIN_ID } from '../brain-registry.ts';

export const collectWritebackConsent: AdvisorCollector = {
  id: 'writeback-consent',
  collect: async (ctx) => {
    if (ctx.remote) return [];
    if (isThinClient(ctx.config)) return [];
    try {
      if (resolveBrainId(undefined) !== HOST_BRAIN_ID) return [];
    } catch {
      return [];
    }
    const [shown, mode] = await Promise.all([
      ctx.engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY),
      ctx.engine.getConfig(AUTO_WRITEBACK_KEY),
    ]);
    if (shown !== 'true' || mode) return [];
    const audience = await classifyBrainAudience(ctx.engine, ctx.config);
    if (audience.audience !== 'personal') return [];
    return [{
      id: 'writeback_consent_pending',
      severity: 'info',
      title: 'Ambient memory writeback is available for this personal brain and still off',
      detail:
        'Agents would save durable facts the user states directly (preferences, decisions, ' +
        'commitments) with provenance; transient facts get a short TTL. Ask the user before ' +
        'anything: enable with `pmbrain config set memory.auto_writeback salient`. ' +
        'Off switch: `pmbrain config set memory.auto_writeback off`.',
      fix: { command_argv: null },
      collector: 'writeback-consent',
      ask_user: true,
    }];
  },
};
