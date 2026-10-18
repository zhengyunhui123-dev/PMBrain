import { expect, test } from 'bun:test';
import { waitForDesktopService } from '../admin/src/product/desktop-startup-wait';

function fixture() {
  let listener: ((state: { phase: string; message?: string }) => void) | undefined; let released = 0;
  return { emit: (phase: string) => listener?.({ phase }), released: () => released, desktop: { getState: async () => ({ phase: 'starting' }), onState: (next: typeof listener) => { listener = next; return () => { released++; listener = undefined; }; } } };
}
test('已有启动失败立即返回原错误，并释放监听', async () => {
  const f = fixture(); f.desktop.getState = async () => ({ phase: 'failed', message: '数据库目录不可写' });
  await expect(waitForDesktopService(f.desktop, { timeoutMs: 100 })).rejects.toThrow('数据库目录不可写'); expect(f.released()).toBe(1);
});
test('先监听再读取状态，不漏掉读取期间的就绪事件，也不被迟到快照覆盖', async () => {
  const f = fixture(); f.desktop.getState = async () => { f.emit('ready'); return { phase: 'starting' }; };
  await waitForDesktopService(f.desktop, { timeoutMs: 100 }); expect(f.released()).toBe(1);
});
test('读取状态异常保持原错误，不再等待整个启动超时', async () => {
  const f = fixture(); f.desktop.getState = async () => { throw new Error('IPC 断开'); };
  await expect(waitForDesktopService(f.desktop, { timeoutMs: 100 })).rejects.toThrow('IPC 断开'); expect(f.released()).toBe(1);
});
test('启动中事件不会吞掉随后状态读取返回的原生错误', async () => {
  const f = fixture(); f.desktop.getState = async () => { f.emit('starting'); throw new Error('状态 IPC 断开'); };
  await expect(waitForDesktopService(f.desktop, { timeoutMs: 100 })).rejects.toThrow('状态 IPC 断开'); expect(f.released()).toBe(1);
});
test('离开页面中止等待，释放监听且不会误报启动失败', async () => {
  const f = fixture(); const abort = new AbortController(); const waiting = waitForDesktopService(f.desktop, { signal: abort.signal, timeoutMs: 100 }); abort.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' }); expect(f.released()).toBe(1);
});
test('超时只停止页面等待，不重启或创建数据库', async () => {
  const f = fixture(); await expect(waitForDesktopService(f.desktop, { timeoutMs: 5 })).rejects.toThrow('启动超时'); expect(f.released()).toBe(1);
});
