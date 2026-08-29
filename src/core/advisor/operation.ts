import { OperationError } from '../operation-error.ts';
import type { OperationContext } from '../operations.ts';
import { VERSION } from '../../version.ts';
import { runAdvisor } from './run.ts';

async function readPublishAdvisor(ctx: OperationContext): Promise<boolean> {
  const fromDb = await ctx.engine.getConfig('mcp.publish_advisor').catch(() => null);
  if (fromDb !== null) return fromDb === 'true';
  return ctx.config?.mcp?.publish_advisor === true;
}

export async function runAdvisorOperation(ctx: OperationContext) {
  if (ctx.remote !== false) {
    const enabled = await readPublishAdvisor(ctx);
    if (!enabled) {
      const err = new OperationError(
        'permission_denied',
        'The advisor is not published over MCP by the brain owner, so it is hidden from your tool catalog. Ask the owner to enable it if you need it.',
        'The owner can enable it with `pmbrain config set mcp.publish_advisor true`.',
      );
      err.detail = 'config_key=mcp.publish_advisor';
      throw err;
    }
  }
  return runAdvisor({
    engine: ctx.engine,
    config: ctx.config,
    version: VERSION,
    workspace: null,
    skillsDir: null,
    now: new Date(),
    remote: ctx.remote !== false,
  });
}
