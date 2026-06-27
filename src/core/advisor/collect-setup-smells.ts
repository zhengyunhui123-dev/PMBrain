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
        detail: 'Semantic search and dedup are reduced until an embedding model is configured.',
        fix: { command_argv: ['pmbrain', 'config', 'set', 'embedding_model', '<model-id>'] },
        collector: 'setup-smells',
        ask_user: true,
      });
    } else if (!cfg.embedding_model && !cfg.zeroentropy_api_key && !process.env.ZEROENTROPY_API_KEY) {
      findings.push({
        id: 'embedding_key_missing',
        severity: 'warn',
        title: 'No embedding provider key is set.',
        detail: 'Set zeroentropy_api_key or choose another provider via embedding_model.',
        fix: { command_argv: ['pmbrain', 'config', 'set', 'zeroentropy_api_key', '<key>'] },
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
