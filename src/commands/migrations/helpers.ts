import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { OrchestratorOpts, OrchestratorPhaseResult } from './types.ts';

export async function createMigrationEngine(): Promise<BrainEngine> {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('PMBrain config not found; save setup before applying migrations.');
  }
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  return engine;
}

export async function closeMigrationEngine(engine: BrainEngine): Promise<void> {
  try { await engine.disconnect(); } catch { /* best-effort */ }
}

export async function runSchemaMigration(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  let engine: BrainEngine | null = null;
  try {
    engine = await createMigrationEngine();
    await engine.initSchema();
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (engine) await closeMigrationEngine(engine);
  }
}
