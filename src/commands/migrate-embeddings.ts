/** Provider-neutral, resumable embedding migration command for PMBrain. */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfigFileOnly } from '../core/config.ts';
import { readContentChunksEmbeddingDim } from '../core/embedding-dim-check.ts';
import { recommendedEmbeddingDimension } from '../core/embedding-dimension-alignment.ts';
import { switchEmbeddingModel } from './config.ts';

const STATE_KEY = 'embedding.migration.inflight';
const COMPLETED_KEY = 'embedding.migration.completed';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function status(engine: BrainEngine) {
  const config = loadConfigFileOnly();
  const column = await readContentChunksEmbeddingDim(engine);
  const models = await engine.executeRaw<{ model: string | null; count: string | number }>(
    `SELECT model, COUNT(*)::bigint AS count
       FROM content_chunks
      WHERE embedding IS NOT NULL
      GROUP BY model
      ORDER BY count DESC`,
  );
  const missing = await engine.countStaleChunks();
  const inflight = await engine.getConfig(STATE_KEY).catch(() => null);
  let stalled = false;
  if (inflight) {
    try {
      const startedAt = Date.parse((JSON.parse(inflight) as { started_at?: string }).started_at ?? '');
      stalled = Number.isFinite(startedAt) && Date.now() - startedAt > 60 * 60 * 1000;
    } catch { stalled = true; }
  }
  return {
    configured_model: config?.embedding_model ?? null,
    configured_dimensions: config?.embedding_dimensions ?? null,
    column_dimensions: column.dims,
    vectors_by_model: models.map((row) => ({ model: row.model, count: Number(row.count) })),
    missing_embeddings: missing,
    inflight,
    stalled,
    completed: await engine.getConfig(COMPLETED_KEY).catch(() => null),
  };
}

export async function runMigrateEmbeddings(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--status')) {
    const report = await status(engine);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Embedding migration status');
      console.log(`  configured: ${report.configured_model ?? '(none)'} @ ${report.configured_dimensions ?? '?'}d`);
      console.log(`  DB column:  ${report.column_dimensions ?? '?'}d`);
      console.log(`  missing:    ${report.missing_embeddings}`);
      console.log(`  vectors:    ${report.vectors_by_model.map((row) => `${row.model ?? '(unlabeled)'}=${row.count}`).join(', ') || 'none'}`);
      console.log(`  inflight:   ${report.inflight ?? 'none'}`);
      console.log(`  stalled:    ${report.stalled ? 'yes (resume with the same --to/--dim --yes command)' : 'no'}`);
    }
    return;
  }

  const target = valueAfter(args, '--to')?.trim();
  if (!target) {
    console.log('Usage: pmbrain migrate embeddings --to <provider:model> [--dim N] [--dry-run] --yes');
    console.log('       pmbrain migrate embeddings --status [--json]');
    return;
  }
  const explicitDim = Number(valueAfter(args, '--dim'));
  let plannedDim = Number.isInteger(explicitDim) && explicitDim > 0 ? explicitDim : null;
  if (plannedDim === null) {
    try { plannedDim = recommendedEmbeddingDimension(target); } catch { /* live probe decides */ }
  }
  const current = await status(engine);
  const plan = {
    from_model: current.configured_model,
    from_dimensions: current.column_dimensions,
    to_model: target,
    to_dimensions: plannedDim,
    vectors_to_replace: current.vectors_by_model.reduce((sum, row) => sum + row.count, 0),
    source_content_preserved: true,
    estimated_cost_usd: null,
  };
  console.log(JSON.stringify({ status: 'planned', plan }, null, 2));
  if (args.includes('--dry-run')) return;
  if (!args.includes('--yes')) {
    throw new Error('Embedding migration requires explicit --yes. No configuration or vectors were changed.');
  }

  const started = JSON.stringify({ ...plan, started_at: new Date().toISOString() });
  await engine.setConfig(STATE_KEY, started);
  try {
    await switchEmbeddingModel(engine, target, { expectedDimensions: plannedDim ?? undefined });
    const committedConfig = loadConfigFileOnly();
    const completed = JSON.stringify({
      to_model: target,
      to_dimensions: committedConfig?.embedding_dimensions ?? plannedDim,
      completed_at: new Date().toISOString(),
    });
    await engine.setConfig(COMPLETED_KEY, completed);
    await engine.unsetConfig(STATE_KEY);
  } catch (error) {
    // Keep the in-flight receipt so the exact command can be resumed.
    throw error;
  }
}
