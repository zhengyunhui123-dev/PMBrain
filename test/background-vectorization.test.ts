import { expect, test } from 'bun:test';
import { vectorizationSchedule, type BackgroundResourceSample } from '../shared/background-vectorization';
import { BackgroundVectorizationScheduler } from '../src/product/tasks/background-vectorization';
import { TaskProgressAdapter, finishTaskProgress } from '../src/product/tasks/progress-adapter';
import { vectorizationRetryDelay } from '../src/product/tasks/search-optimize';
import { TaskProductProgressSchema } from '../shared/contracts/common';

const gib = 1024 ** 3;
const idle: BackgroundResourceSample = { cpuBusyRatio: 0.1, bytes: gib, availableBytes: 12 * gib, totalBytes: 16 * gib, systemIdleSeconds: 120 };

test('电脑与软件空闲时正常运行，半闲置减小批次，忙时等待', () => {
  expect(vectorizationSchedule(idle, 120000, false, false)).toMatchObject({ mode: 'full', batchSize: 32, delayMs: 0 });
  expect(vectorizationSchedule({ ...idle, cpuBusyRatio: 0.55, systemIdleSeconds: 5 }, 30000, false, false)).toMatchObject({ mode: 'gentle', batchSize: 4 });
  for (const sample of [{ ...idle, cpuBusyRatio: 0.9 }, { ...idle, availableBytes: 512 * 1024 ** 2 }, { ...idle, commitHeadroomBytes: 128 * 1024 ** 2 }]) {
    expect(vectorizationSchedule(sample, 120000, false, false).mode).toBe('waiting');
  }
  expect(vectorizationSchedule(idle, 120000, true, false).mode).toBe('waiting');
  expect(vectorizationSchedule(idle, 1000, false, false).mode).toBe('waiting');
  expect(vectorizationSchedule({ ...idle, cpuBusyRatio: null }, 120000, false, false).mode).toBe('gentle');
});

test('前台请求结束后自动恢复，真实操作会让向量化让路，轮询不会刷新操作时间', () => {
  let now = 100000;
  const scheduler = new BackgroundVectorizationScheduler({ sample: () => idle, now: () => now });
  expect(scheduler.decision().mode).toBe('full');
  const finish = scheduler.beginForeground();
  expect(scheduler.decision().mode).toBe('waiting');
  now += 120000;
  expect(scheduler.decision().mode).toBe('waiting');
  finish(); finish();
  now += 10000;
  expect(scheduler.decision().mode).toBe('gentle');
  now += 60000;
  expect(scheduler.decision().mode).toBe('full');
  scheduler.noteActivity();
  expect(scheduler.decision().mode).toBe('waiting');
});

test('桌面资源样本过期时不认为电脑全空闲，内存恢复后留出缓冲时间', () => {
  let now = 100000;
  const scheduler = new BackgroundVectorizationScheduler({ sample: () => idle, now: () => now });
  scheduler.updateDesktopSample({ ...idle, availableBytes: 128 * 1024 ** 2 });
  expect(scheduler.decision().mode).toBe('waiting');
  scheduler.updateDesktopSample(idle);
  expect(scheduler.decision().mode).toBe('waiting');
  now += 16000;
  expect(scheduler.decision().mode).toBe('gentle');
  scheduler.updateDesktopSample(idle);
  expect(scheduler.decision().mode).toBe('full');
});

test('知识向量化等待空闲不显示失败或丢失已保存进度', () => {
  const adapter = new TaskProgressAdapter('embed_stale');
  adapter.view.background = { mode: 'waiting', reason: '等待电脑空闲' };
  adapter.view.stage = '等待电脑空闲';
  adapter.view.processed = 3;
  adapter.view.total = 8;
  const progress = finishTaskProgress(adapter.view, 'queued', undefined, null);
  expect(progress.name).toBe('知识向量化');
  expect(progress.stage).toBe('等待电脑空闲');
  expect(progress.processed).toBe(3);
  expect(progress.errorReason).toBeNull();
  expect(TaskProductProgressSchema.parse(progress).background).toEqual({ mode: 'waiting', reason: '等待电脑空闲' });
});

test('仅对暂时故障有限重试，不重复调用配置错误或无权限的模型', () => {
  expect(vectorizationRetryDelay('503 Service Unavailable', 0)).toBe(30000);
  expect(vectorizationRetryDelay('fetch failed', 2)).toBe(120000);
  expect(vectorizationRetryDelay('503 Service Unavailable', 5)).toBeNull();
  for (const message of ['401 Unauthorized', '未配置完整的向量模型', 'embedding dimensions mismatch', 'insufficient_quota']) expect(vectorizationRetryDelay(message, 0)).toBeNull();
});
