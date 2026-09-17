import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseTransferController, type DatabaseTransferDependencies } from '../src/main/database/database-transfer.js';
import { desktopConfigPath, writeJsonConfig } from '../src/main/config-manager.js';

const previousHome = process.env.PMBRAIN_HOME;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (previousHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previousHome;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(failAt?: 'copy' | 'start'): {
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
    runCliChecked: async (_runtime, args) => {
      events.push(args[0] === 'pglite-backup' ? 'backup' : 'copy');
      if (args[0] === 'migrate' && failAt === 'copy') throw new Error('逐表校验失败');
      return { code: 0, signal: null, stderr: '', stdout: args[0] === 'pglite-backup'
        ? JSON.stringify({ status: 'created', backup_directory: join(home, 'backup') })
        : JSON.stringify({ status: 'verified', tables: [{ name: 'pages', rows: 2, sha256: 'abc' }] }) };
    },
    sendProgress: () => undefined,
    hideProgress: () => undefined,
  };
  return { controller: new DatabaseTransferController(dependencies), events, configPath };
}

describe('desktop full database transfer', () => {
  test('copies and verifies before switching the configured engine', async () => {
    const { controller, events, configPath } = fixture();
    const result = await controller.migrate();
    expect(events).toEqual(['stop', 'backup', 'provision', 'copy', 'start']);
    expect(result.rows).toBe(2);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('postgres');
  });

  test('keeps PGLite configured when transfer verification fails', async () => {
    const { controller, events, configPath } = fixture('copy');
    await expect(controller.migrate()).rejects.toThrow('逐表校验失败');
    expect(events).toEqual(['stop', 'backup', 'provision', 'copy', 'stop', 'start']);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('pglite');
  });

  test('restores PGLite configuration if the new sidecar cannot start', async () => {
    const { controller, events, configPath } = fixture('start');
    await expect(controller.migrate()).rejects.toThrow('Postgres 无法启动');
    expect(events).toEqual(['stop', 'backup', 'provision', 'copy', 'start', 'stop', 'start']);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).engine).toBe('pglite');
  });
});
