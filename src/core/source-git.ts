import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const MAX_COMMIT_MESSAGE_LENGTH = 200;

export interface SourceGitInitResult {
  created: boolean;
  path: string;
}

export interface SourceGitCommitResult {
  committed: boolean;
  path: string;
  changedFiles: number;
  commit: string | null;
  shortCommit: string | null;
  message: string;
}

export interface SourceGitStatus {
  repository: boolean;
  hasChanges: boolean;
  changedFiles: number;
  lastCommitAt: string | null;
}

function assertSourceDirectory(inputPath: string): string {
  const localPath = resolve(inputPath);
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new Error(`Source directory does not exist: ${localPath}`);
  }
  return localPath;
}

function runGit(localPath: string, args: string[], allowFailure = false): string {
  const result = spawnSync('git', ['-C', localPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    },
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || `git exited with code ${result.status}`).trim();
    throw new Error(detail);
  }
  return result.stdout.trim();
}

function ensureLocalIdentity(localPath: string): void {
  if (!runGit(localPath, ['config', '--local', '--get', 'user.name'], true)) {
    runGit(localPath, ['config', '--local', 'user.name', 'PMBrain']);
  }
  if (!runGit(localPath, ['config', '--local', '--get', 'user.email'], true)) {
    runGit(localPath, ['config', '--local', 'user.email', 'pmbrain@localhost']);
  }
}

export function isSourceGitRepository(inputPath: string): boolean {
  const localPath = resolve(inputPath);
  return existsSync(join(localPath, '.git'));
}

function listCommittableChanges(localPath: string): string[] {
  const pending = runGit(localPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=dirty',
  ]);
  return pending ? pending.split('\0').filter(Boolean) : [];
}

function readLastCommitAt(localPath: string): string | null {
  const value = runGit(localPath, ['log', '-1', '--format=%cI'], true);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function getSourceGitStatus(inputPath: string): SourceGitStatus {
  const localPath = assertSourceDirectory(inputPath);
  if (!isSourceGitRepository(localPath)) {
    return { repository: false, hasChanges: false, changedFiles: 0, lastCommitAt: null };
  }
  const changes = listCommittableChanges(localPath);
  return {
    repository: true,
    hasChanges: changes.length > 0,
    changedFiles: changes.length,
    lastCommitAt: readLastCommitAt(localPath),
  };
}

export function initializeSourceGit(inputPath: string): SourceGitInitResult {
  const localPath = assertSourceDirectory(inputPath);
  if (isSourceGitRepository(localPath)) {
    return { created: false, path: localPath };
  }
  runGit(localPath, ['init']);
  ensureLocalIdentity(localPath);
  return { created: true, path: localPath };
}

export function commitSourceGit(inputPath: string, requestedMessage?: string): SourceGitCommitResult {
  const localPath = assertSourceDirectory(inputPath);
  if (!isSourceGitRepository(localPath)) {
    throw new Error('This source is not a Git repository. Create Git first.');
  }

  const trimmedMessage = requestedMessage?.trim() ?? '';
  if (trimmedMessage.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new Error(`Commit message cannot exceed ${MAX_COMMIT_MESSAGE_LENGTH} characters`);
  }
  const message = trimmedMessage || `PMBrain 保存 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  // A parent repository cannot commit uncommitted files that only exist
  // inside a nested repository/submodule. Ignore that dirty-only signal so
  // the UI and CLI both report a clean no-op instead of running `git commit`
  // and surfacing Git's "no changes added" error.
  const changedFiles = listCommittableChanges(localPath).length;
  if (changedFiles === 0) {
    return {
      committed: false,
      path: localPath,
      changedFiles: 0,
      commit: null,
      shortCommit: null,
      message,
    };
  }

  ensureLocalIdentity(localPath);
  runGit(localPath, ['add', '-A']);
  runGit(localPath, ['commit', '--no-gpg-sign', '-m', message]);
  const commit = runGit(localPath, ['rev-parse', 'HEAD']);
  return {
    committed: true,
    path: localPath,
    changedFiles,
    commit,
    shortCommit: commit.slice(0, 8),
    message,
  };
}
