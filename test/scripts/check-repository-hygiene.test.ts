import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'scripts', 'check-repository-hygiene.sh');

function resolveBashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const gitPath = `${spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout ?? ''}`
    .split(/\r?\n/)
    .find(Boolean);
  if (gitPath) {
    const gitBash = resolve(dirname(gitPath), '..', 'bin', 'bash.exe');
    if (existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

const BASH_EXECUTABLE = resolveBashExecutable();

function runWithTrackedFiles(paths: string[]): { exitCode: number; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), 'pmbrain-repository-hygiene-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: directory });
    for (const path of paths) {
      const absolute = join(directory, ...path.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'fixture');
    }
    spawnSync('git', ['add', '-f', '--', ...paths], { cwd: directory });
    const result = spawnSync(BASH_EXECUTABLE, [SCRIPT_PATH], { cwd: directory, encoding: 'utf8' });
    return { exitCode: result.status ?? -1, stderr: result.stderr ?? '' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('check-repository-hygiene.sh', () => {
  test('allows source files, example env files, and the tracked NSIS source', () => {
    const result = runWithTrackedFiles([
      'src/example.ts',
      '.env.testing.example',
      'desktop/build/installer.nsh',
    ]);
    expect(result.exitCode).toBe(0);
  });

  test('rejects a file-backed PGLite test database', () => {
    const result = runWithTrackedFiles([
      '.tmp-pglite-reopen-test/brain.pglite/pg_wal/00000001',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('brain.pglite');
  });

  test('rejects local credentials, context, and logs', () => {
    const result = runWithTrackedFiles([
      '.mcp.json',
      '.env.local',
      'developer.env',
      'context/debug.md',
      'pmbrain-debug.log',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('.mcp.json');
    expect(result.stderr).toContain('.env.local');
    expect(result.stderr).toContain('developer.env');
    expect(result.stderr).toContain('context/debug.md');
    expect(result.stderr).toContain('pmbrain-debug.log');
  });

  test('rejects generated desktop output and release artifacts', () => {
    const result = runWithTrackedFiles([
      'desktop/out/main/index.js',
      'desktop/dist/PMBrain-Linux-x64.AppImage',
      'desktop/dist/latest-linux.yml.blockmap',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('desktop/out/main/index.js');
    expect(result.stderr).toContain('PMBrain-Linux-x64.AppImage');
  });
});
