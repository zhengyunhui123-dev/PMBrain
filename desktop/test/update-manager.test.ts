import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { UpdateManager } from '../src/main/update-manager.js';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  downloaded = false;
  installed = false;

  async checkForUpdates() {
    this.emit('checking-for-update');
    this.emit('update-available', { version: '1.0.22' });
  }

  async downloadUpdate() {
    this.downloaded = true;
    this.emit('download-progress', { percent: 51.2 });
    this.emit('update-downloaded', { version: '1.0.22' });
  }

  quitAndInstall() { this.installed = true; }
}

const logger = { write() {}, close() {}, directory: '', filePath: '' } as any;

describe('desktop update manager', () => {
  test('checks, automatically downloads, then stops sidecar before install', async () => {
    const updater = new FakeUpdater();
    let stopped = false;
    const states: string[] = [];
    const manager = new UpdateManager({
      updater, packaged: true, currentVersion: '1.0.21', logger,
      beforeInstall: async () => { stopped = true; },
      onState: (state) => states.push(state.phase),
    });
    await manager.check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updater.autoDownload).toBe(false);
    expect(updater.downloaded).toBe(true);
    expect(manager.currentState.phase).toBe('downloaded');
    expect(states).toContain('downloading');
    await manager.install();
    expect(stopped).toBe(true);
    expect(updater.installed).toBe(true);
  });
});
