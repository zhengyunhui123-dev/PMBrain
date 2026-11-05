import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine';
import type { SyncFileManifest } from '../src/product/tasks/sync-file-queue';
import { classifyQuickScanHash, classifyQuickScanStat, loadQuickScanFingerprints, quickScanManifestKey, saveQuickScanFingerprints } from '../src/product/tasks/quick-scan-index';
import { QuickSyncPlan } from '../src/product/tasks/quick-sync-plan';
import { syncFileCompatibleFingerprints, syncFileContentFingerprint } from '../src/product/tasks/checkpoint';
import type { SyncFileInput } from '../src/product/tasks/types';
import { withEnv } from './helpers/with-env';

const home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-scan-'));

afterAll(() => {
  if (resolve(home).startsWith(resolve(tmpdir()) + sep) && home.includes('pmbrain-quick-scan-')) rmSync(home, { recursive: true, force: true });
});

const manifest = (patch: Partial<SyncFileManifest> = {}): SyncFileManifest => ({
  hash: 'abc', fingerprint: 'finger', slug: 'note', pageHash: 'page', size: 12, mtime: 20, chunks: 1, ...patch,
});

test('快速维护后深度整理复用普通文档比对结果，识图资料仍须按识图配置处理', () => {
  const quick = { sourceId: 'default', noEmbed: true, includeOffice: true, includeImages: true, documentOcr: false };
  const deep = { ...quick, documentOcr: true };
  const stored = manifest({ fingerprint: syncFileContentFingerprint(quick) });
  for (const path of ['note.md', 'record.txt', 'meeting.jsonl']) {
    expect(classifyQuickScanStat(stored, 12, 20, syncFileContentFingerprint(deep), syncFileCompatibleFingerprints(deep, path))).toBe('unchanged');
  }
  for (const path of ['scan.pdf', 'photo.png', 'slides.pptx']) {
    expect(classifyQuickScanStat(stored, 12, 20, syncFileContentFingerprint(deep), syncFileCompatibleFingerprints(deep, path))).toBe('same-bytes');
  }
  const textOnly = { ...quick, includeImages: false, documentOcr: false };
  expect(classifyQuickScanStat(stored, 12, 20, syncFileContentFingerprint(textOnly), syncFileCompatibleFingerprints(textOnly, 'note.md'))).toBe('unchanged');
  expect(classifyQuickScanStat(stored, 12, 20, syncFileContentFingerprint(textOnly), syncFileCompatibleFingerprints(textOnly, 'photo.png'))).toBe('same-bytes');
  const differentSource = { ...deep, sourceId: 'other' };
  expect(classifyQuickScanStat(stored, 12, 20, syncFileContentFingerprint(differentSource), syncFileCompatibleFingerprints(differentSource, 'note.md'))).toBe('same-bytes');
});

test('3195份资料仅1份变化时，不因识图开关把其余3194份重新放入导入清单', () => {
  const quick = { sourceId: 'default', noEmbed: true, includeOffice: true, includeImages: true, documentOcr: false };
  const deep = { ...quick, documentOcr: true };
  const stored = manifest({ fingerprint: syncFileContentFingerprint(quick) });
  const current = syncFileContentFingerprint(deep);
  let before = 0, after = 0;
  for (let index = 0; index < 3195; index++) {
    const size = index === 3194 ? 13 : 12;
    if (classifyQuickScanStat(stored, size, 20, current, [syncFileContentFingerprint({ ...deep, documentOcr: true })]) !== 'unchanged') before++;
    if (classifyQuickScanStat(stored, size, 20, current, syncFileCompatibleFingerprints(deep, `note-${index}.md`)) !== 'unchanged') after++;
  }
  expect(before).toBe(3195);
  expect(after).toBe(1);
  console.log(`固定清单比对：旧配置兼容判断待检查 ${before} 份，修复后 ${after} 份；复用 ${3195-after} 份。`);
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

test('扫描过程只把清单追加到本地，结束才保存到库；中断后能接着用同一份清单', async () => withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
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
}));
