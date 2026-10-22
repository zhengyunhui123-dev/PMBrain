import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { toEngineConfig } from '../src/core/config.ts';

const root = mkdtempSync(join(tmpdir(), 'pmbrain-upgrade-empty-regression-'));
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'PMBRAIN_DATABASE_URL', 'GBRAIN_DATABASE_URL'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
process.env.PMBRAIN_HOME = root;
afterAll(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });

test('首次创建、正常升级保留记录、旧库缺失停止且修正路径后仍可读回', async () => {
  const path = join(root, 'brain.pglite'), retained = join(root, 'retained.pglite');
  const config = { engine: 'pglite' as const, database_path: path, desktop: { setup_completed: false } };
  const first = new PGLiteEngine();
  await first.connect(toEngineConfig(config));
  try {
    await first.executeRaw('CREATE TABLE upgrade_safety_probe(id int PRIMARY KEY, body text)');
    await first.executeRaw('INSERT INTO upgrade_safety_probe VALUES(1,$1)', ['Preserve existing knowledge.']);
  } finally { await first.disconnect(); }
  config.desktop.setup_completed = true;
  const normal = new PGLiteEngine();
  await normal.connect(toEngineConfig(config));
  try { expect((await normal.executeRaw<{body:string}>('SELECT body FROM upgrade_safety_probe'))[0].body).toBe('Preserve existing knowledge.'); }
  finally { await normal.disconnect(); }
  for (const target of [path, retained]) if (relative(root, target).startsWith('..')) throw new Error('Fixture path escaped');
  renameSync(path, retained);
  const missing = new PGLiteEngine();
  await expect(missing.connect(toEngineConfig(config))).rejects.toThrow('原有');
  await missing.disconnect();
  expect(existsSync(path)).toBe(false);
  mkdirSync(path);
  const empty = new PGLiteEngine();
  await expect(empty.connect(toEngineConfig(config))).rejects.toThrow('PG_VERSION');
  await empty.disconnect();
  expect(existsSync(join(path, 'PG_VERSION'))).toBe(false);
  const restored = new PGLiteEngine();
  await restored.connect(toEngineConfig({ ...config, database_path: retained }));
  try { expect((await restored.executeRaw<{body:string}>('SELECT body FROM upgrade_safety_probe'))[0].body).toBe('Preserve existing knowledge.'); }
  finally { await restored.disconnect(); }
}, 60000);
