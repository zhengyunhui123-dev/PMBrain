/**
 * Export the derived `links` table before a bulk relationship backfill.
 *
 * The backup stays under the active PMBrain home and may contain private
 * page references. It is intentionally never written into the repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';

const config = loadConfig();
if (!config) throw new Error('No PMBrain configuration found.');

const engineConfig = toEngineConfig(config);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);

try {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    'SELECT * FROM links ORDER BY id',
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(configDir(), 'backups', 'links');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `links-before-backfill-${stamp}.json`);
  const payload = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    row_count: rows.length,
    rows,
  };
  writeFileSync(
    path,
    `${JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  console.log(JSON.stringify({ path, row_count: rows.length }));
} finally {
  await engine.disconnect();
}
