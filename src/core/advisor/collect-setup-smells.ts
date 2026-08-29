import { isEmbeddingConfigured } from '../embedding-dim-check.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

async function dbBool(ctx: { engine: { getConfig(k: string): Promise<string | null> } }, key: string): Promise<boolean | null> {
  try {
    const v = await ctx.engine.getConfig(key);
    if (v == null) return null;
    return v === 'true';
  } catch {
    return null;
  }
}

export const collectSetupSmells: AdvisorCollector = {
  id: 'setup-smells',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];
    const cfg = ctx.config ?? {};

    if (cfg.embedding_disabled === true) {
      findings.push({
        id: 'embeddings_disabled',
        severity: 'warn',
        title: 'Embeddings are disabled.',
        detail: 'Semantic search stays on keywords, titles, and relations until an embedding model and dimensions are configured.',
        fix: { command_argv: ['pmbrain', 'config', 'set', 'embedding_model', '<provider:model>'] },
        collector: 'setup-smells',
        ask_user: true,
      });
    } else if (!isEmbeddingConfigured(cfg)) {
      findings.push({
        id: 'embedding_not_configured',
        severity: 'warn',
        title: 'No embedding model is configured.',
        detail: 'PMBrain has no default vector provider. Set embedding_model and embedding_dimensions before vector search can run.',
        fix: { command_argv: ['pmbrain', 'config', 'set', 'embedding_model', '<provider:model>'] },
        collector: 'setup-smells',
        ask_user: true,
      });
    }

    if (cfg.remote_mcp) {
      const publishDb = await dbBool(ctx, 'mcp.publish_skills');
      const publish = publishDb ?? (cfg as { mcp?: { publish_skills?: boolean } }).mcp?.publish_skills === true;
      if (!publish) {
        findings.push({
          id: 'publish_skills_off',
          severity: 'info',
          title: 'Skill publishing is off while PMBrain serves agents over MCP.',
          detail: 'Connected agents may miss this brain capability surface.',
          fix: { command_argv: ['pmbrain', 'config', 'set', 'mcp.publish_skills', 'true'] },
          collector: 'setup-smells',
          ask_user: true,
        });
      }
    }

    return findings;
  },
};
