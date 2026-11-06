import { expect, test } from 'bun:test';
import { ProductTaskRuntime } from '../src/product/tasks/runtime';

test('进度刷新很慢时只保留一轮在途刷新，并在最后补上最新状态', async () => {
  const runtime = Object.create(ProductTaskRuntime.prototype) as any;
  runtime.stopped = false;
  runtime.sessionRefresh = new Map();
  let inFlight = 0, peak = 0;
  const releases: Array<() => void> = [];
  const seen: string[] = [];
  runtime.refreshSession = async (_id: number, file: string) => {
    inFlight++; peak = Math.max(peak, inFlight); seen.push(file);
    await new Promise<void>(resolve => releases.push(resolve));
    inFlight--;
  };
  runtime.scheduleSessionRefresh(1, 'first.md');
  await Bun.sleep(550);
  runtime.scheduleSessionRefresh(1, 'second.md');
  await Bun.sleep(550);
  runtime.scheduleSessionRefresh(1, 'last.md');
  expect(peak).toBe(1);
  releases.shift()?.();
  await Bun.sleep(550);
  expect(seen).toEqual(['first.md', 'last.md']);
  releases.shift()?.();
  runtime.stopped = true;
}, 10000);
