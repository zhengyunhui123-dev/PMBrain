import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('src/renderer/index.html'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
const ipc = readFileSync(resolve('src/main/ipc-handlers.ts'), 'utf8');
const styles = readFileSync(resolve('src/renderer/style.css'), 'utf8');

describe('desktop recovery process controls', () => {
  test('offers a guarded terminate-and-restart action only for a verified owner', () => {
    expect(html).toContain('id="recovery-terminate"');
    expect(html).toContain('结束占用进程并重启');
    expect(html).toContain('不会删除数据库、知识内容或锁文件');
    expect(renderer).toContain('getPgliteRecoveryStatus()');
    expect(renderer).toContain('status.canTerminate && status.pid');
    expect(renderer).toContain('terminatePgliteOwnerAndRetry(pid)');
    expect(renderer).toContain('只会结束经过身份校验的 PMBrain 占用进程');
    expect(preload).toContain("ipcRenderer.invoke('desktop:get-pglite-recovery-status')");
    expect(preload).toContain("ipcRenderer.invoke('desktop:terminate-pglite-owner-and-retry', pid)");
    expect(ipc).toContain("registerTrustedHandler('desktop:get-pglite-recovery-status'");
    expect(ipc).toContain("registerTrustedHandler('desktop:terminate-pglite-owner-and-retry'");
    expect(styles).toContain('.recovery-terminate');
  });
});
