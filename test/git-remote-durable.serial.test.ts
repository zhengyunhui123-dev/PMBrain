import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  divergenceSafePull,
  detectDefaultBranch,
  isWorkingTreeDirty,
  pushProbe,
} from '../src/core/git-remote.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  }).trim();
}

let root: string;
let oldAllow: string | undefined;

function makePair(): { bare: string; work: string } {
  const bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@example.test');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* best effort */ }
  return { bare, work };
}

function secondClone(bare: string): string {
  const work = mkdtempSync(join(root, 'work2-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'u@example.test');
  git(work, 'config', 'user.name', 'tester2');
  return work;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pmbrain-git-durable-'));
  oldAllow = process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
});

afterEach(() => {
  if (oldAllow === undefined) delete process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  else process.env.PMBRAIN_GIT_ALLOW_FILE_TRANSPORT = oldAllow;
  rmSync(root, { recursive: true, force: true });
});

describe('git durability helpers', () => {
  test('detectDefaultBranch resolves origin/HEAD', () => {
    const { work } = makePair();
    expect(detectDefaultBranch(work)).toBe('main');
  });

  test('isWorkingTreeDirty tracks local edits', () => {
    const { work } = makePair();
    expect(isWorkingTreeDirty(work)).toBe(false);
    writeFileSync(join(work, 'README.md'), 'changed\n');
    expect(isWorkingTreeDirty(work)).toBe(true);
  });

  test('divergenceSafePull advances a clean tree', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    git(other, 'add', 'b.txt');
    git(other, 'commit', '-qm', 'b');
    git(other, 'push', '-q', 'origin', 'main');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('advanced');
    expect(existsSync(join(work, 'b.txt'))).toBe(true);
  });

  test('divergenceSafePull skips dirty trees', () => {
    const { work } = makePair();
    writeFileSync(join(work, 'README.md'), 'local edit\n');
    expect(divergenceSafePull(work, 'main').status).toBe('skipped_dirty');
  });

  test('pushProbe succeeds against writable local origin', () => {
    const { work } = makePair();
    expect(pushProbe(work, 'main')).toEqual({ ok: true });
  });
});
