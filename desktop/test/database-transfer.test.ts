import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseTransferController, type DatabaseTransferDependencies } from '../src/main/database/database-transfer.js';
import { desktopConfigPath, writeJsonConfig } from '../src/main/config-manager.js';

const previousHome = process.env.PMBRAIN_HOME;
const temporaryDirectories: string[] = [];
const fingerprint = 'a'.repeat(64);

afterEach(() => {
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previousHome;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(failAt?: 'copy' | 'start', unknown = false): {
  controller: DatabaseTransferController;
  events: string[];
  configPath: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'pmbrain-transfer-test-'));
  temporaryDirectories.push(home);
  process.env.PMBRAIN_HOME = home;
  const configPath = desktopConfigPath();
  writeJsonConfig(configPath, { engine: 'pglite', database_path: join(home, 'brain.pglite'), desktop: { setup_completed: true } });
  const events: string[] = [];
  let state: { phase: 'ready' | 'failed' } = { phase: 'ready' };
  const sidecar = {
    get state() { return state; },
    stop: async () => { events.push('stop'); state = { phase: 'failed' }; },
    start: async () => { events.push('start'); if (failAt === 'start' && readFileSync(configPath, 'utf8').includes('"postgres"')) throw new Error('Postgres 无法启动'); state = { phase: 'ready' }; },
  };
  const dependencies: DatabaseTransferDependencies = {
    runtime: () => ({ packaged: false, appPath: home, resourcesPath: home }),
    sidecar: sidecar as DatabaseTransferDependencies['sidecar'],
    databaseRuntime: {
      provisionLocalPostgres: async () => {
        events.push('provision');
        expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('pglite');
        return { containerName: 'pmbrain-postgres-test', volumeName: 'pmbrain-postgres-data-test', databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:5432/pmbrain' };
      },
    },
    runCliChecked: async (_runtime, args, extraEnv) => {
      events.push(args[0] === 'pglite-backup' ? 'backup' : args.includes('--preflight') ? 'scan' : 'copy');
      if (args[0] === 'pglite-backup') mkdirSync(join(home, 'backup', 'brain.pglite'), { recursive: true });
      if (args[0] === 'migrate' && !args.includes('--preflight')) {
        expect(String(extraEnv.PMBRAIN_MIGRATION_SOURCE_BACKUP_PATH).endsWith('brain.pglite')).toBe(true);
        expect(extraEnv.PMBRAIN_MIGRATION_SOURCE_BACKUP_PATH).not.toBe(join(home, 'backup', 'brain.pglite'));
        expect(extraEnv.PMBRAIN_MIGRATION_SOURCE_BACKUP_PATH && existsSync(extraEnv.PMBRAIN_MIGRATION_SOURCE_BACKUP_PATH)).toBe(true);
        expect(extraEnv.PMBRAIN_MIGRATION_SKIP_TABLES).toBe(JSON.stringify(unknown ? ['legacy_unknown'] : []));
      }
      if (args[0] === 'migrate' && !args.includes('--preflight') && failAt === 'copy') throw new Error('逐表校验失败');
      return { code: 0, signal: null, stderr: '', stdout: args[0] === 'pglite-backup'
        ? JSON.stringify({ status: 'created', backup_directory: join(home, 'backup') })
        : args.includes('--preflight')
          ? JSON.stringify({ fingerprint, schemaVersion: '124', tables: [
            { name: 'pages', rows: 2, action: 'direct', reason: '按现有结构迁移' },
            ...(unknown ? [{ name: 'legacy_unknown', rows: 1, action: 'unknown', reason: '当前版本没有对应数据表', skippable: true }] : []),
          ], vectors: [] })
          : JSON.stringify({ status: 'verified', tables: [{ name: 'pages', rows: 2, sha256: 'abc' }], skippedTables: [] }) };
    },
    sendProgress: () => undefined,
    hideProgress: () => undefined,
  };
  return { controller: new DatabaseTransferController(dependencies), events, configPath };
}

describe('desktop full database transfer', () => {
  test('copies and verifies before switching the configured engine', async () => {
    const { controller, events, configPath } = fixture();
    const plan = await controller.preflight();
    expect(plan.fingerprint).toBe(fingerprint);
    const result = await controller.migrate(plan.fingerprint, false);
    expect(events).toEqual(['stop', 'scan', 'start', 'stop', 'scan', 'backup', 'provision', 'copy', 'start']);
    expect(result.rows).toBe(2);
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).totalRows).toBe(2);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('postgres');
  });

  test('keeps PGLite configured when transfer verification fails', async () => {
    const { controller, events, configPath } = fixture('copy');
    await expect(controller.migrate(fingerprint, false)).rejects.toThrow('逐表校验失败');
    expect(events).toEqual(['stop', 'scan', 'backup', 'provision', 'copy', 'stop', 'start']);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('pglite');
  });

  test('restores PGLite configuration if the new sidecar cannot start', async () => {
    const { controller, events, configPath } = fixture('start');
    await expect(controller.migrate(fingerprint, false)).rejects.toThrow('Postgres 无法启动');
    expect(events).toEqual(['stop', 'scan', 'backup', 'provision', 'copy', 'start', 'stop', 'start']);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('pglite');
  });

  test('requires a deliberate decision before skipping an unknown legacy table', async () => {
    const { controller, events, configPath } = fixture(undefined, true);
    const plan = await controller.preflight();
    await expect(controller.migrate(plan.fingerprint, false)).rejects.toThrow('未知旧表');
    expect(events).toEqual(['stop', 'scan', 'start', 'stop', 'scan', 'stop', 'start']);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('pglite');
    await controller.migrate(plan.fingerprint, true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('postgres');
  });
});
