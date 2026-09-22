import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectIntegrationLaunchTarget,
  launchIntegration,
} from '../src/main/integration-launcher.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-integration-launch-'));
  roots.push(root);
  return root;
}

test('detects an installed desktop client from the normal Windows program directory', () => {
  const localAppData = tempRoot();
  const executable = join(localAppData, 'Programs', 'cursor', 'Cursor.exe');
  mkdirSync(join(localAppData, 'Programs', 'cursor'), { recursive: true });
  writeFileSync(executable, 'fixture');

  expect(detectIntegrationLaunchTarget('cursor', {
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
    startMenuRoots: [],
  })).toEqual({ path: executable, source: 'installed' });
});

test('recognizes an application shortcut without scanning the whole computer', () => {
  const startMenu = tempRoot();
  const shortcut = join(startMenu, 'TraeWork CN', 'TraeWork CN.lnk');
  mkdirSync(join(startMenu, 'TraeWork CN'), { recursive: true });
  writeFileSync(shortcut, 'fixture');

  expect(detectIntegrationLaunchTarget('trae', {
    platform: 'win32',
    env: {},
    startMenuRoots: [startMenu],
  })).toEqual({ path: shortcut, source: 'shortcut' });
});

test('launches only the detected target and reports when no matching app is installed', async () => {
  const startMenu = tempRoot();
  const shortcut = join(startMenu, 'WorkBuddy.lnk');
  writeFileSync(shortcut, 'fixture');
  const opened: string[] = [];

  await launchIntegration('workbuddy', async path => {
    opened.push(path);
    return '';
  }, {
    platform: 'win32',
    env: {},
    startMenuRoots: [startMenu],
  });
  expect(opened).toEqual([shortcut]);

  await expect(launchIntegration('cherry', async () => '', {
    platform: 'win32',
    env: {},
    startMenuRoots: [],
  })).rejects.toThrow('未检测到 CherryStudio');
});
