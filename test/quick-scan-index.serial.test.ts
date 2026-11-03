import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine';
import { configPath } from '../src/core/config';
import { PostgresEngine } from '../src/core/postgres-engine';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { loadQuickScanFingerprints, quickScanManifestKey, saveQuickScanFingerprints } from '../src/product/tasks/quick-scan-index';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';

let engine: BrainEngine, root: string;
const databaseUrl = process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'PMBRAIN_DATABASE_URL'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const sourceId = 'quick-scan-index';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-quick-scan-db-'));
  for (const key of keys) delete process.env[key];
  process.env.PMBRAIN_HOME = root;
  process.env.GBRAIN_HOME = root;
  mkdirSync(join(root, '.pmbrain'));
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  writeFileSync(configPath(), JSON.stringify({ engine: databaseUrl ? 'postgres' : 'pglite', model_usage: { generative_enabled: false, embedding_enabled: false } }));
  engine = databaseUrl ? new PostgresEngine() : new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : {});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine?.disconnect();
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  if (root && resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('pmbrain-quick-scan-db-')) rmSync(root, { recursive: true, force: true });
}, 60000);

test('扫描只批量读取和写回文件指纹，不写任务表', async () => {
  const sourceRoot = join(root, 'library');
  const files = ['a.md', 'b.md', 'c.md'].map(name => join(sourceRoot, 'notes', name));
  const stored = files.map((file, index) => ({
    key: quickScanManifestKey(sourceId, sourceRoot, relative(sourceRoot, file)),
    value: { hash: `hash-${index}`, fingerprint: 'finger', slug: `note-${index}`, pageHash: `page-${index}`, size: 10 + index, mtime: 100 + index },
  }));
  const before = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
  try {
    for (const row of stored) await engine.setConfig(row.key, JSON.stringify(row.value));
    const loaded = await loadQuickScanFingerprints(engine, sourceId, sourceRoot, join(root, 'elsewhere'), files);
    expect(loaded.size).toBe(3);
    expect(loaded.get(stored[0].key)).toMatchObject(stored[0].value);
    const refreshed = { ...stored[1].value, mtime: 999 };
    await saveQuickScanFingerprints(engine, [{ key: stored[1].key, value: JSON.stringify(refreshed) }]);
    expect(JSON.parse((await engine.getConfig(stored[1].key)) ?? '{}')).toMatchObject(refreshed);
    expect(JSON.parse((await engine.getConfig(stored[0].key)) ?? '{}').mtime).toBe(100);
    const after = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
    expect(String(after[0]?.count)).toBe(String(before[0]?.count));
  } finally {
    for (const row of stored) await engine.unsetConfig(row.key);
  }
}, 60000);
