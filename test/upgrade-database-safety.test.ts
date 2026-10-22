import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePmbrainConfigDirectory } from '../shared/pmbrain-config-home.ts';
import { requireExistingPgliteDatabase } from '../src/core/pmbrain-adapters/pglite-database-path.ts';
import { toEngineConfig } from '../src/core/config.ts';

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'pmbrain-upgrade-safety-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('Windows 默认与旧 HOME 目录一致解析；已有唯一配置保留，冲突配置停止', () => {
  const root = fixture(), home = join(root, 'home'), profile = join(root, 'profile');
  const env = { HOME: home, USERPROFILE: profile };
  expect(resolvePmbrainConfigDirectory(env, 'win32', root)).toBe(join(profile, '.pmbrain'));
  mkdirSync(join(home, '.pmbrain'), { recursive: true });
  writeFileSync(join(home, '.pmbrain', 'config.json'), '{"database_path":"old"}');
  expect(resolvePmbrainConfigDirectory(env, 'win32', root)).toBe(join(home, '.pmbrain'));
  mkdirSync(join(profile, '.pmbrain'), { recursive: true });
  writeFileSync(join(profile, '.pmbrain', 'config.json'), '{"database_path":"other"}');
  expect(() => resolvePmbrainConfigDirectory(env, 'win32', root)).toThrow('多个');
  expect(resolvePmbrainConfigDirectory({ ...env, PMBRAIN_HOME: home }, 'win32', root)).toBe(join(home, '.pmbrain'));
  expect(readFileSync(join(home, '.pmbrain', 'config.json'), 'utf8')).toContain('old');
});

test('新用户和显式 HOME 隔离保留；相对覆盖路径不写入', () => {
  const root = fixture();
  expect(resolvePmbrainConfigDirectory({ HOME: root }, 'linux', '/unused')).toBe(join(root, '.pmbrain'));
  expect(() => resolvePmbrainConfigDirectory({ PMBRAIN_HOME: 'relative' }, 'win32', root)).toThrow('absolute');
  expect(() => resolvePmbrainConfigDirectory({ PMBRAIN_HOME: join(root, 'x') + '/../other' }, 'win32', root)).toThrow('..');
});

test('已用旧库缺失或空目录时拒绝打开，不创建数据库；正常库只读放行', () => {
  const root = fixture(), path = join(root, 'brain.pglite');
  expect(() => requireExistingPgliteDatabase(path)).toThrow('原有');
  expect(existsSync(path)).toBe(false);
  mkdirSync(path);
  expect(() => requireExistingPgliteDatabase(path)).toThrow('PG_VERSION');
  writeFileSync(join(path, 'PG_VERSION'), '17\n');
  expect(() => requireExistingPgliteDatabase(path)).not.toThrow();
  expect(readFileSync(join(path, 'PG_VERSION'), 'utf8')).toBe('17\n');
});

test('仅已配置桌面库要求已有数据库，首次创建和独立 CLI 保留建库能力', () => {
  const base = { engine: 'pglite' as const, database_path: '/fixture/brain.pglite' };
  expect(toEngineConfig({ ...base, desktop: { setup_completed: true } }).require_existing_database).toBe(true);
  expect(toEngineConfig({ ...base, desktop: { last_migrated_version: '1.5.12' } }).require_existing_database).toBe(true);
  expect(toEngineConfig({ ...base, desktop: { setup_completed: false, last_migrated_version: '1.5.12' } }).require_existing_database).toBe(true);
  expect(toEngineConfig({ ...base, desktop: { setup_completed: false } }).require_existing_database).toBeUndefined();
  expect(toEngineConfig(base).require_existing_database).toBeUndefined();
  expect(toEngineConfig({ ...base, engine: 'postgres', desktop: { setup_completed: true } }).require_existing_database).toBeUndefined();
});
