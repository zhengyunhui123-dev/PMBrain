import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeConfigDirectory, desktopConfigPath, getSetupInfo, markDesktopMigration, needsDesktopMigration,
  restoreConfig, saveSetup, writeJsonConfig,
} from '../src/main/config-manager.js';

const originalHome = process.env.PMBRAIN_HOME;
const originalLegacyHome = process.env.GBRAIN_HOME;
const roots: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalHome;
  if (originalLegacyHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalLegacyHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-config-'));
  roots.push(root);
  process.env.PMBRAIN_HOME = root;
  return root;
}

describe('desktop config manager', () => {
  test('reads a legacy local config without rewriting database or API keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'pmbrain-desktop-legacy-'));
    roots.push(root);
    delete process.env.PMBRAIN_HOME;
    process.env.GBRAIN_HOME = root;
    const path = join(root, '.gbrain', 'config.json');
    const original = {
      engine: 'postgres',
      database_url: 'postgresql://local:secret@127.0.0.1:5432/pmbrain',
      deepseek_api_key: 'existing-key',
    };
    writeJsonConfig(path, original);
    const before = readFileSync(path, 'utf8');
    const info = getSetupInfo();
    expect(activeConfigDirectory()).toBe(join(root, '.gbrain'));
    expect(info.needsSetup).toBe(false);
    expect(info.current.engine).toBe('postgres');
    expect(info.current.databaseConfigured).toBe(true);
    expect(info.current.keyStatus.deepseek).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('creates secure PGLite config and preserves keys on a later switch', () => {
    const root = isolatedHome();
    const pglite = join(root, 'brain.pglite');
    const first = saveSetup({
      engine: 'pglite', databasePath: pglite, knowledgeDirectory: join(root, 'knowledge'), keys: { zhipu: 'zhipu-test' },
    });
    const path = desktopConfigPath();
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.engine).toBe('pglite');
    expect(config.database_path).toBe(pglite);
    expect(config.zhipu_api_key).toBe('zhipu-test');
    expect(config.admin_bootstrap_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(config.desktop.knowledge_source_id).toMatch(/^desktop-[0-9a-f]{8}$/);
    expect(getSetupInfo().needsSetup).toBe(false);
    expect(needsDesktopMigration('1.0.21')).toBe(true);
    markDesktopMigration('1.0.21');
    expect(needsDesktopMigration('1.0.21')).toBe(false);

    saveSetup({ engine: 'postgres', databaseUrl: 'postgresql://u:p@127.0.0.1:5432/brain', keys: { zhipu: '' } });
    const switched = JSON.parse(readFileSync(path, 'utf8'));
    expect(switched.engine).toBe('postgres');
    expect(switched.database_path).toBeUndefined();
    expect(switched.zhipu_api_key).toBe('zhipu-test');
    expect(existsSync(join(root, '.pmbrain', 'backups', 'config'))).toBe(true);

    restoreConfig(first.snapshot);
    expect(existsSync(path)).toBe(false);
  });
});
