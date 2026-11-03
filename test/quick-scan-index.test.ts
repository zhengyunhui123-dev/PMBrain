import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine';
import type { SyncFileManifest } from '../src/product/tasks/sync-file-queue';
import { classifyQuickScanHash, classifyQuickScanStat, loadQuickScanFingerprints, quickScanManifestKey, saveQuickScanFingerprints } from '../src/product/tasks/quick-scan-index';
import { QuickSyncPlan } from '../src/product/tasks/quick-sync-plan';
import type { SyncFileInput } from '../src/product/tasks/types';

const home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-scan-'));
const savedHome = process.env.PMBRAIN_HOME;
const savedLegacy = process.env.GBRAIN_HOME;
process.env.PMBRAIN_HOME = home;
process.env.GBRAIN_HOME = home;

afterAll(() => {
  if (savedHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = savedHome;
  if (savedLegacy === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedLegacy;
  if (resolve(home).startsWith(resolve(tmpdir()) + sep) && home.includes('pmbrain-quick-scan-')) rmSync(home, { recursive: true, force: true });
});

const manifest = (patch: Partial<SyncFileManifest> = {}): SyncFileManifest => ({
  hash: 'abc', fingerprint: 'finger', slug: 'note', pageHash: 'page', size: 12, mtime: 20, chunks: 1, ...patch,
});

test('大小和修改时间相同就跳过读全文；变了才比哈希', () => {
  const stored = manifest();
  expect(classifyQuickScanStat(stored, 12, 20, 'finger')).toBe('unchanged');
  expect(classifyQuickScanStat(stored, 12, 20, 'other', ['finger'])).toBe('unchanged');
  expect(classifyQuickScanStat(stored, 12, 20, 'other')).toBe('same-bytes');
  expect(classifyQuickScanStat(stored, 13, 20, 'finger')).toBe('read');
  expect(classifyQuickScanStat(manifest({ size: undefined }), 12, 20, 'finger')).toBe('read');
  expect(classifyQuickScanHash(stored, 'abc', 'finger', undefined, 12, 21)).toEqual({ unchanged: true, refresh: true });
  expect(classifyQuickScanHash(stored, 'changed', 'finger', undefined, 13, 21)).toEqual({ unchanged: false, refresh: false });
  expect(classifyQuickScanHash(undefined, 'abc', 'finger', undefined, 12, 20)).toEqual({ unchanged: false, refresh: false });
});

test('比对表按批读取和写回，不按文件各打一次库', async () => {
  const calls: string[] = [];
  const engine = { async executeRaw(sql: string) { calls.push(sql); return sql.startsWith('SELECT') ? [{ key: 'sync.file.sha256:test', value: JSON.stringify(manifest()) }] : []; } } as unknown as BrainEngine;
  const paths = Array.from({ length: 501 }, (_, index) => join(home, `note-${index}.md`));
  const loaded = await loadQuickScanFingerprints(engine, 'default', home, home, paths);
  expect(calls.filter(sql => sql.startsWith('SELECT'))).toHaveLength(2);
  expect(loaded.size).toBe(1);
  await saveQuickScanFingerprints(engine, [{ key: 'sync.file.sha256:test', value: '{}' }]);
  expect(calls.some(sql => sql.includes('unnest'))).toBe(true);
  expect(calls.some(sql => /minion_jobs/i.test(sql))).toBe(false);
});

test('文件都在知识源目录里时，比对键用知识源路径，和导入时同一条相对路径', async () => {
  const sourceRoot = join(home, 'library');
  const walkRoot = join(home, 'elsewhere');
  const inside = join(sourceRoot, 'notes', 'a.md');
  const outside = join(walkRoot, 'b.md');
  const seen: string[][] = [];
  const engine = { async executeRaw(_sql: string, params?: unknown[]) { seen.push([...(params?.[0] as string[] ?? [])]); return []; } } as unknown as BrainEngine;
  await loadQuickScanFingerprints(engine, 'default', sourceRoot, walkRoot, [inside]);
  expect(seen[0]?.[0]).toBe(quickScanManifestKey('default', sourceRoot, relative(sourceRoot, inside)));
  await loadQuickScanFingerprints(engine, 'default', sourceRoot, walkRoot, [inside, outside]);
  expect(seen[1]?.[0]).toBe(quickScanManifestKey('default', sourceRoot, relative(walkRoot, inside)));
  expect(seen[1]?.[1]).toBe(quickScanManifestKey('default', sourceRoot, relative(walkRoot, outside)));
});

function sample(path: string, unchanged: boolean): SyncFileInput {
  return { path, relativePath: path, sourceRoot: home, originalSize: 3, originalMtime: 1, hash: unchanged ? 'same' : 'new', fingerprint: 'finger', modelFingerprint: 'model', options: { sourceId: 'default', noEmbed: true } };
}

test('扫描过程只把清单追加到本地，结束才保存到库；中断后能接着用同一份清单', async () => {
  process.env.PMBRAIN_HOME = home;
  process.env.GBRAIN_HOME = home;
  const checkpoint = { phases: {}, reports: {} };
  let saves = 0;
  const plan = new QuickSyncPlan(checkpoint, async () => { saves++; }, () => {}, 7);
  const paths = Array.from({ length: 40 }, (_, index) => join(home, `item-${index}.md`));
  await plan.list(home, () => paths);
  for (const [index, path] of paths.entries()) await plan.record(sample(path, index % 2 === 0), index % 2 === 0);
  expect(saves).toBe(0);
  expect(plan.current.checked).toBe(40);
  const interrupted = new QuickSyncPlan({ phases: {}, reports: {} }, async () => { saves++; }, () => {}, 7);
  await interrupted.restore('default');
  expect(interrupted.sources.default.paths).toHaveLength(40);
  expect(interrupted.sources.default.checked).toBe(32);
  expect(interrupted.sources.default.complete).toBe(false);
  await plan.finish();
  expect(saves).toBe(1);
  expect(plan.current.complete).toBe(true);
  const resumed = new QuickSyncPlan({ phases: {}, reports: {} }, async () => { saves++; }, () => {}, 7);
  await resumed.restore('default');
  expect(resumed.sources.default.paths).toHaveLength(40);
  expect(resumed.sources.default.checked).toBe(40);
  expect(resumed.sources.default.unchanged).toBe(20);
  expect(resumed.sources.default.entries).toHaveLength(20);
  expect(resumed.sources.default.entries.every(file => file.scanValidated)).toBe(true);
  expect(resumed.sources.default.complete).toBe(false);
  expect(saves).toBe(1);
});
