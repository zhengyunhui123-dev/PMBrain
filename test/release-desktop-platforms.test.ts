import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const testWorkflow = readFileSync(join(process.cwd(), '.github/workflows/test.yml'), 'utf8');
const heavyWorkflow = readFileSync(join(process.cwd(), '.github/workflows/heavy-tests.yml'), 'utf8');
const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };

describe('Windows desktop release gates', () => {
  test('Release builds and publishes only the Windows package and updater files', () => {
    expect(releaseWorkflow).toContain('platform: windows');
    expect(releaseWorkflow).toContain('pmbrain-desktop-windows');
    expect(releaseWorkflow).toContain('PMBrain-Windows-x64-Setup-*.exe');
    expect(releaseWorkflow).toContain('PMBrain-Windows-x64-Setup-*.exe.blockmap');
    expect(releaseWorkflow).toContain('latest.yml');
    expect(releaseWorkflow).toContain('needs: [desktop]');
    for (const removed of [
      'gbrain-darwin-arm64',
      'gbrain-linux-x64',
      'platform: macos',
      'platform: linux',
      'build:mac',
      'build:linux',
      'latest-mac.yml',
      'latest-linux.yml',
      'PMBrain-macOS-arm64-',
      'PMBrain-Linux-x64-',
    ]) {
      expect(releaseWorkflow).not.toContain(removed);
    }
  });

  test('normal Test CI runs the runtime smoke on all desktop platforms', () => {
    expect(testWorkflow).toContain('desktop-runtime');
    expect(testWorkflow).toContain('windows-latest');
    expect(testWorkflow).toContain('macos-latest');
    expect(testWorkflow).toContain('ubuntu-latest');
    expect(testWorkflow).toContain('bun run verify:runtime');
  });

  test('heavy operational tests run automatically for every master change and pull request', () => {
    expect(heavyWorkflow).toContain('push:');
    expect(heavyWorkflow).toContain('branches: [master]');
    expect(heavyWorkflow).not.toContain("contains(github.event.pull_request.labels.*.name, 'heavy-tests')");
  });

  test('one complete local test command includes static, unit, slow, heavy, and database E2E tiers', () => {
    const command = rootPackage.scripts['test:complete'];
    expect(command).toContain('bun run verify');
    expect(command).toContain('run-unit-parallel.sh');
    expect(command).toContain('bun run test:slow');
    expect(command).toContain('bun run test:heavy');
    expect(command).toContain('run-e2e.sh');
  });
});
