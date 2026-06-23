import { describe, expect, test } from 'bun:test';
import { SidecarManager } from '../src/main/sidecar-manager.js';

const logger = { write() {}, close() {}, directory: '', filePath: '' } as any;

describe('desktop sidecar manager', () => {
  test('terminates the child when startup health checks fail', async () => {
    const manager = new SidecarManager({
      packaged: false,
      appPath: '',
      resourcesPath: '',
      port: 3131,
      bootstrapToken: 'test-bootstrap-token',
      clientVersion: '1.0.23',
      logger,
    });
    let terminated = false;
    (manager as any).spawnProcess = () => undefined;
    (manager as any).waitUntilHealthy = async () => { throw new Error('health failed'); };
    (manager as any).terminateChild = async () => { terminated = true; };

    await expect(manager.start()).rejects.toThrow('health failed');
    expect(terminated).toBe(true);
  });
});
