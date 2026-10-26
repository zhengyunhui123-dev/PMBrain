import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMaintenanceCheckpoint, resumeMaintenanceCheckpoint } from '../src/product/tasks/checkpoint';
import type { ProductTask, MaintenanceCheckpoint } from '../src/product/tasks/types';
import { WorkbenchMemoryCoordinator } from '../src/product/workbench/memory';

test('关闭记忆协调器等待正在读取的回执，完成后不再访问数据库', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0;
  const engine = { executeRaw: async () => { if (++reads === 1) { entered(); await blocked; } return []; } } as any;
  const store = { root: mkdtempSync(join(tmpdir(), 'pmbrain-memory-close-')), list: () => [{ id: 'conversation', messages: [{ id: 'message', role: 'user', status: 'complete', memory: { status: 'complete', factIds: [1], sourceId: 'default', hash: 'hash' } }] }] } as any;
  const coordinator = new WorkbenchMemoryCoordinator(engine, store, async () => { throw new Error('关闭后不得提交'); }, async () => null);
  const scan = coordinator.scan(); await reading;
  let closed = false; const closing = Promise.resolve(coordinator.close()).then(() => { closed = true; });
  try { await Promise.resolve(); expect(closed).toBe(false); }
  finally { release(); await scan; await closing; }
  expect(closed).toBe(true); const count = reads; await coordinator.scan(); expect(reads).toBe(count);
});

test('记忆写入后的知识整理可以保存检查点，并从失败阶段继续', () => {
  const task: ProductTask = { type: 'memory', input: { root: 'isolated', conversationId: 'conversation', messageId: 'message', hash: 'hash', sourceId: 'default' } };
  const checkpoint: MaintenanceCheckpoint = { phases: { default: [{ phase: 'synthesize', status: 'fail', summary: 'interrupted', duration_ms: 1, details: {} } as any] }, reports: {} };
  setMaintenanceCheckpoint(task, checkpoint);
  const restored: ProductTask = JSON.parse(JSON.stringify(task));
  expect(restored.type).toBe('memory');
  if (restored.type !== 'memory') throw new Error('任务类型改变');
  expect(restored.input.knowledgeCheckpoint).toEqual(checkpoint);
  resumeMaintenanceCheckpoint(restored.input.knowledgeCheckpoint!, true);
  expect(restored.input.knowledgeCheckpoint?.phases.default).toEqual([]);
});

test('不接受没有知识整理阶段的任务写入维护检查点', () => {
  expect(() => setMaintenanceCheckpoint({ type: 'embed', input: {} } as ProductTask, { phases: {}, reports: {} })).toThrow('检查点');
});
