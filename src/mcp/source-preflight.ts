import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';

export async function assertStdioSourceBindable(
  engine: BrainEngine,
  env: string | undefined = process.env.PMBRAIN_SOURCE,
): Promise<void> {
  if (!env) return;
  if (env === '__all__' || !isValidSourceId(env)) return;
  let rows: Array<{ id: string }>;
  try {
    rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1 AND archived = false`,
      [env],
    );
  } catch (e) {
    process.stderr.write(
      `[pmbrain] source preflight skipped (could not read sources): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return;
  }
  if (rows.length === 0) {
    throw new Error(
      `PMBRAIN_SOURCE="${env}" is not a registered active source (missing or archived); ` +
      `refusing to serve a phantom scope (reads would return nothing, writes would fail ` +
      `on the sources foreign key). Run \`pmbrain sources list\`, then set PMBRAIN_SOURCE ` +
      `to a listed id or unset it.`,
    );
  }
}
