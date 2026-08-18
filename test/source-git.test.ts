import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitSourceGit,
  getSourceGitStatus,
  initializeSourceGit,
  isSourceGitRepository,
} from '../src/core/source-git.ts';

const temporaryDirectories: string[] = [];

function makeSourceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pmbrain-source-git-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Source Git version control', () => {
  test('creates a repository without committing source files', () => {
    const directory = makeSourceDirectory();
    writeFileSync(join(directory, 'note.md'), '# Note\n');

    const result = initializeSourceGit(directory);

    expect(result.created).toBe(true);
    expect(isSourceGitRepository(directory)).toBe(true);
    expect(commitSourceGit(directory, 'First version')).toMatchObject({
      committed: true,
      changedFiles: 1,
      message: 'First version',
    });
  }, 20_000);

  test('commits all changes and reports a no-op when the tree is clean', () => {
    const directory = makeSourceDirectory();
    initializeSourceGit(directory);
    writeFileSync(join(directory, 'first.md'), 'one\n');
    const first = commitSourceGit(directory, 'Initial');
    writeFileSync(join(directory, 'second.md'), 'two\n');
    const second = commitSourceGit(directory, 'Add second');
    const clean = commitSourceGit(directory, 'Nothing');

    expect(first.shortCommit).toHaveLength(8);
    expect(second.committed).toBe(true);
    expect(second.commit).not.toBe(first.commit);
    expect(clean).toMatchObject({ committed: false, changedFiles: 0, commit: null });
  }, 20_000);

  test('reports whether the source has changes the parent repository can commit', () => {
    const directory = makeSourceDirectory();
    initializeSourceGit(directory);

    expect(getSourceGitStatus(directory)).toMatchObject({ repository: true, hasChanges: false, changedFiles: 0, lastCommitAt: null });

    writeFileSync(join(directory, 'note.md'), 'content\n');
    expect(getSourceGitStatus(directory)).toMatchObject({ repository: true, hasChanges: true, changedFiles: 1, lastCommitAt: null });

    commitSourceGit(directory, 'Save note');
    const afterCommit = getSourceGitStatus(directory);
    expect(afterCommit).toMatchObject({ repository: true, hasChanges: false, changedFiles: 0 });
    expect(afterCommit.lastCommitAt).toBeTruthy();
    expect(Number.isNaN(new Date(afterCommit.lastCommitAt ?? '').getTime())).toBe(false);
  }, 20_000);

  test('does not offer a parent commit for changes that exist only inside a nested repository', () => {
    const directory = makeSourceDirectory();
    initializeSourceGit(directory);
    writeFileSync(join(directory, 'root.md'), 'root\n');
    commitSourceGit(directory, 'Initial parent');

    const nested = join(directory, 'nested');
    mkdirSync(nested);
    initializeSourceGit(nested);
    writeFileSync(join(nested, 'note.md'), 'nested\n');
    commitSourceGit(nested, 'Initial nested');
    commitSourceGit(directory, 'Track nested repository');

    writeFileSync(join(nested, 'note.md'), 'nested changed\n');

    expect(getSourceGitStatus(directory)).toMatchObject({ repository: true, hasChanges: false, changedFiles: 0 });
    expect(commitSourceGit(directory, 'Cannot commit nested worktree')).toMatchObject({
      committed: false,
      changedFiles: 0,
      commit: null,
    });
  }, 20_000);

  test('requires explicit initialization and bounds commit messages', () => {
    const directory = makeSourceDirectory();
    expect(() => commitSourceGit(directory, 'No repository')).toThrow('not a Git repository');
    initializeSourceGit(directory);
    writeFileSync(join(directory, 'note.md'), 'content\n');
    expect(() => commitSourceGit(directory, 'x'.repeat(201))).toThrow('cannot exceed 200');
  }, 20_000);
});
