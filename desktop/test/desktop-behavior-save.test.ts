import { expect, test } from 'bun:test';
import { createDesktopBehaviorSaver } from '../src/renderer/desktop-behavior-save';
import type { DesktopBehaviorInput } from '../src/main/system-settings';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('快速修改启动选项串行保存，等待时的多次选择只保存最后一份', async () => {
  let draft: DesktopBehaviorInput = { launchAtLogin: false, startMinimized: false, closeBehavior: 'tray' };
  const first = deferred<typeof draft>(); const writes: typeof draft[] = []; const saved: typeof draft[] = []; const states: string[] = [];
  const saver = createDesktopBehaviorSaver({ read: () => ({ ...draft }), persist: async input => { writes.push(input); return writes.length === 1 ? first.promise : input; }, saved: value => saved.push(value), feedback: state => states.push(state) });
  const work = saver.save();
  draft = { ...draft, launchAtLogin: true }; void saver.save();
  draft = { ...draft, startMinimized: true }; void saver.save();
  expect(writes).toHaveLength(1); expect(saver.busy).toBe(true);
  first.resolve(writes[0]); await work;
  expect(writes).toEqual([{ launchAtLogin: false, startMinimized: false, closeBehavior: 'tray' }, draft]);
  expect(saved).toEqual([draft]); expect(states.at(-1)).toBe('saved'); expect(saver.busy).toBe(false);
});

test('保存失败保留选择，不自动重复请求，手动重试才再次保存', async () => {
  const draft: DesktopBehaviorInput = { launchAtLogin: true, startMinimized: false, closeBehavior: 'quit' };
  let attempts = 0; const errors: string[] = []; const saved: typeof draft[] = [];
  const saver = createDesktopBehaviorSaver({ read: () => ({ ...draft }), persist: async input => { if (++attempts === 1) throw new Error('系统拒绝保存'); return input; }, saved: value => saved.push(value), feedback: (state, error) => { if (state === 'error') errors.push(error!); } });
  await saver.save(); expect(attempts).toBe(1); expect(errors).toEqual(['系统拒绝保存']); expect(saved).toEqual([]); expect(draft.launchAtLogin).toBe(true);
  await saver.save(); expect(attempts).toBe(2); expect(saved).toEqual([draft]);
});

test('旧请求失败时，新选择仍按用户操作继续保存，不显示旧错误覆盖新结果', async () => {
  let draft: DesktopBehaviorInput = { launchAtLogin: false, startMinimized: false, closeBehavior: 'tray' }; let attempts = 0;
  const first = deferred<void>(); const states: string[] = [];
  const saver = createDesktopBehaviorSaver({ read: () => ({ ...draft }), persist: async input => { if (++attempts === 1) { await first.promise; throw new Error('旧请求失败'); } return input; }, saved: () => {}, feedback: state => states.push(state) });
  const work = saver.save(); draft = { ...draft, launchAtLogin: true }; void saver.save(); first.resolve(); await work;
  expect(attempts).toBe(2); expect(states).not.toContain('error'); expect(states.at(-1)).toBe('saved');
});
