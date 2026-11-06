import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import type { SyncFileInput, MaintenanceCheckpoint } from './types';
import type { MaintenanceRoundProgress } from '../../../shared/maintenance-progress';
import { quickScanLogPath } from './checkpoint.ts';
import { loadQuickScanFingerprints, quickScanManifestKey, refreshedManifest, saveQuickScanFingerprints } from './quick-scan-index.ts';
import type { SyncFileManifest } from './sync-file-queue.ts';

const LOG_BATCH = 32;

type ScanLogLine =
  | { type: 'plan'; sourceId: string; root: string; paths: string[] }
  | { type: 'file'; sourceId: string; unchanged: boolean; file: SyncFileInput };

export class QuickSyncPlan {
  preparing = true;
  sourceId = 'default';
  private checked = new Map<string, Set<string>>();
  private files = new Map<string, Map<string, SyncFileInput>>();
  private fingerprints = new Map<string, Map<string, SyncFileManifest>>();
  private refreshes = new Map<string, Map<string, string>>();
  private logBuffer: string[] = [];
  private logLines: ScanLogLine[] | null = null;
  private restored = new Set<string>();
  constructor(private checkpoint: MaintenanceCheckpoint, private save: () => Promise<unknown>, readonly notify: (scan: MaintenanceRoundProgress['scan']) => void, private jobId: number | null = null) {
    checkpoint.quickSync ??= { sources: {} };
  }
  get sources() { return this.checkpoint.quickSync!.sources; }
  get current() { return this.sources[this.sourceId]; }
  file(path: string) {
    if (!this.files.has(this.sourceId)) this.files.set(this.sourceId, new Map(this.current.entries.map(file => [file.path, file])));
    return this.files.get(this.sourceId)!.get(path);
  }
  stored(sourceRoot: string, relativePath: string) {
    return this.fingerprints.get(this.sourceId)?.get(quickScanManifestKey(this.sourceId, sourceRoot, relativePath));
  }
  async loadFingerprints(engine: BrainEngine, sourceRoot: string, root: string, paths: readonly string[]) {
    if (this.fingerprints.has(this.sourceId)) return;
    this.fingerprints.set(this.sourceId, await loadQuickScanFingerprints(engine, this.sourceId, sourceRoot, root, paths));
  }
  noteRefresh(sourceRoot: string, relativePath: string, size: number, mtimeMs: number, ctimeMs?: number) {
    const key = quickScanManifestKey(this.sourceId, sourceRoot, relativePath);
    const stored = this.fingerprints.get(this.sourceId)?.get(key);
    if (!stored) return;
    const next = refreshedManifest(stored, size, mtimeMs, ctimeMs);
    this.fingerprints.get(this.sourceId)!.set(key, next);
    const bucket = this.refreshes.get(this.sourceId) ?? new Map<string, string>();
    bucket.set(key, JSON.stringify(next));
    this.refreshes.set(this.sourceId, bucket);
  }
  async flushRefreshes(engine: BrainEngine) {
    const bucket = this.refreshes.get(this.sourceId);
    if (!bucket?.size) return;
    await saveQuickScanFingerprints(engine, [...bucket].map(([key, value]) => ({ key, value })));
    bucket.clear();
  }
  async restore(sourceId = this.sourceId) {
    if (this.sources[sourceId] || this.restored.has(sourceId)) return;
    this.restored.add(sourceId);
    const lines = (await this.readLog()).filter(line => line.sourceId === sourceId);
    const planLine = [...lines].reverse().find(line => line.type === 'plan');
    if (!planLine || planLine.type !== 'plan') return;
    const plan = { root: planLine.root, paths: planLine.paths, checked: 0, checkedPaths: [] as string[], unchanged: 0, entries: [] as SyncFileInput[], complete: false };
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.type !== 'file' || seen.has(line.file.path)) continue;
      seen.add(line.file.path);
      plan.checkedPaths.push(line.file.path);
      plan.checked++;
      if (line.unchanged) plan.unchanged++;
      else plan.entries.push(line.file);
    }
    this.sources[sourceId] = plan;
    this.checked.set(sourceId, seen);
  }
  async list(root: string, discover: () => string[]) {
    await this.restore();
    if (!this.current) {
      const paths = discover();
      if (paths.length > 20000) throw new Error('资源保护：本轮扫描资料超过 20000 份，未创建导入清单。');
      this.sources[this.sourceId] = { root, paths, checked: 0, checkedPaths: [], unchanged: 0, entries: [], complete: false };
      await this.writeLog(JSON.stringify({ type: 'plan', sourceId: this.sourceId, root, paths } satisfies ScanLogLine));
    }
    if (this.current.root !== root) throw new Error('知识源路径已改变，本轮固定清单不能用于新路径');
    return [...this.current.paths];
  }
  imports() {
    if (!this.current) return undefined;
    if (!this.preparing) return this.current.entries.map(file => file.path);
    const checked = this.checked.get(this.sourceId) ?? new Set(this.current.checkedPaths);
    this.checked.set(this.sourceId, checked);
    return this.current.paths.filter(path => !checked.has(path));
  }
  async record(file: SyncFileInput, unchanged: boolean) {
    const plan = this.current;
    const checked = this.checked.get(this.sourceId) ?? new Set(plan.checkedPaths);
    this.checked.set(this.sourceId, checked);
    if (checked.has(file.path)) return;
    checked.add(file.path);
    plan.checkedPaths.push(file.path);
    plan.checked++;
    if (unchanged) plan.unchanged++;
    else plan.entries.push({ ...file, scanValidated: true });
    this.logBuffer.push(JSON.stringify({ type: 'file', sourceId: this.sourceId, unchanged, file: unchanged ? file : plan.entries.at(-1)! } satisfies ScanLogLine));
    if (this.logBuffer.length >= LOG_BATCH) await this.flushLog();
    this.notify(this.scan(false));
  }
  async finish() {
    await this.flushLog();
    this.current.complete = true;
    await this.save();
    this.notify(this.scan(false));
  }
  async discardLog() {
    await this.flushLog();
    if (!this.jobId) return;
    await rm(quickScanLogPath(this.jobId), { force: true });
  }
  scan(complete: boolean): MaintenanceRoundProgress['scan'] {
    const plans = Object.values(this.sources), scanned = plans.reduce((sum, plan) => sum + plan.checked, 0);
    return { scanned, unchanged: plans.reduce((sum, plan) => sum + plan.unchanged, 0),
      incremental: complete ? plans.reduce((sum, plan) => sum + plan.entries.length, 0) : undefined,
      total: complete ? scanned : undefined, complete };
  }
  private async flushLog() {
    if (!this.logBuffer.length) return;
    const lines = this.logBuffer;
    this.logBuffer = [];
    await this.writeLog(lines.join('\n'));
  }
  private async writeLog(text: string) {
    if (!this.jobId) return;
    const path = quickScanLogPath(this.jobId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${text}\n`, { mode: 0o600 });
    this.logLines = null;
  }
  private async readLog(): Promise<ScanLogLine[]> {
    if (this.logLines) return this.logLines;
    if (!this.jobId) return this.logLines = [];
    const text = await readFile(quickScanLogPath(this.jobId), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    return this.logLines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as ScanLogLine);
  }
}
