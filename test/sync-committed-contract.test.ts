import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

const SYNC_SOURCE = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'pmbrain-committed-sync-'));
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'sync@test.invalid');
  git(repo, 'config', 'user.name', 'Sync Test');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes', 'base.md'), '# Base\n\ncommitted baseline\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'baseline');
  return repo;
}

async function pageBody(engine: PGLiteEngine, slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ compiled_truth: string }>(
    `SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
  return rows[0]?.compiled_truth ?? null;
}

describe('sync committed Git baseline contract', () => {
  test('inspects the working tree with porcelain status and materializes HEAD without tar', () => {
    expect(SYNC_SOURCE).toContain("'status'");
    expect(SYNC_SOURCE).toContain("'--porcelain=v1'");
    expect(SYNC_SOURCE).toContain('GIT_OPTIONAL_LOCKS');
    expect(SYNC_SOURCE).toContain('parseGitStatusPorcelainZ');
    expect(SYNC_SOURCE).not.toContain("['diff', '--name-status', '-M', 'HEAD']");
    expect(SYNC_SOURCE).not.toContain("'ls-files', '--others', '--exclude-standard'");
    expect(SYNC_SOURCE).not.toContain("execFileSync('tar'");
    expect(SYNC_SOURCE).not.toContain('git archive');
    expect(SYNC_SOURCE).toContain("'checkout'");
    expect(SYNC_SOURCE).toContain('--pathspec-from-file=');
  });

  let engine: PGLiteEngine;
  let home: string;
  const repos: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pmbrain-committed-home-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    for (const repo of repos) if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  async function reset(): Promise<string> {
    await engine.executeRaw('DELETE FROM content_chunks');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw('DELETE FROM op_checkpoints').catch(() => {});
    await engine.setConfig('sync.last_commit', '');
    await engine.setConfig('sync.repo_path', '');
    await engine.unsetConfig('sync.include_working_tree').catch(() => {});
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  test('first/full sync imports HEAD, reports dirty files, and ignores live working-tree content by default', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const repo = await reset();
      writeFileSync(join(repo, 'notes', 'base.md'), '# Base\n\nuncommitted edit\n');
      writeFileSync(join(repo, 'notes', 'draft.md'), '# Draft\n\nuntracked\n');

      const result = await performSync(engine, {
        repoPath: repo,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        skipLock: true,
      });

      expect(result.status).toBe('first_sync');
      expect(result.uncommitted).toEqual({ added: 1, modified: 1, deleted: 0 });
      expect(await pageBody(engine, 'notes/base')).toContain('committed baseline');
      expect(await pageBody(engine, 'notes/base')).not.toContain('uncommitted edit');
      expect(await pageBody(engine, 'notes/draft')).toBeNull();
      expect(await engine.getConfig('sync.last_commit')).toBe(git(repo, 'rev-parse', 'HEAD'));
    });
  }, 120_000);

  test('workingTree opt-in imports live edits and untracked files even on the first/full path', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const repo = await reset();
      writeFileSync(join(repo, 'notes', 'base.md'), '# Base\n\nuncommitted edit\n');
      writeFileSync(join(repo, 'notes', 'draft.md'), '# Draft\n\nuntracked\n');

      const result = await performSync(engine, {
        repoPath: repo,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        skipLock: true,
        workingTree: true,
      });

      expect(result.status).toBe('first_sync');
      expect(result.uncommitted).toBeUndefined();
      expect(await pageBody(engine, 'notes/base')).toContain('uncommitted edit');
      expect(await pageBody(engine, 'notes/draft')).toContain('untracked');
    });
  }, 120_000);

  test('default incremental sync imports committed changes and only reports remaining worktree drift', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const repo = await reset();
      await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true, skipLock: true });

      writeFileSync(join(repo, 'notes', 'committed.md'), '# Committed\n\nlanded\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'committed delta');
      writeFileSync(join(repo, 'notes', 'committed.md'), '# Committed\n\nuncommitted replacement\n');
      writeFileSync(join(repo, 'notes', 'draft.md'), '# Draft\n\nnot committed\n');

      const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true, skipLock: true });
      expect(result.status).toBe('synced');
      expect(result.uncommitted).toEqual({ added: 1, modified: 1, deleted: 0 });
      expect(await pageBody(engine, 'notes/committed')).toContain('landed');
      expect(await pageBody(engine, 'notes/committed')).not.toContain('uncommitted replacement');
      expect(await pageBody(engine, 'notes/draft')).toBeNull();
    });
  }, 120_000);

  test('up-to-date sync with a dirty autocrlf Obsidian working tree stays up_to_date', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const repo = await reset();
      await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true, skipLock: true });

      mkdirSync(join(repo, '.obsidian'), { recursive: true });
      writeFileSync(join(repo, '.obsidian', 'workspace.json'), '{"tabs":[]}\n');
      writeFileSync(join(repo, 'notes', 'base.md'), '# Base\n\nuncommitted edit\n');
      git(repo, 'config', 'core.autocrlf', 'true');

      const startedAt = Date.now();
      const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, noExtract: true, skipLock: true });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(result.status).toBe('up_to_date');
      expect(result.uncommitted).toEqual({ added: 0, modified: 1, deleted: 0 });
      expect(await pageBody(engine, 'notes/base')).toContain('committed baseline');
      expect(await pageBody(engine, 'notes/base')).not.toContain('uncommitted edit');
    });
  }, 120_000);

  test('blocked full sync preserves a DB checkpoint and resumes successful files without advancing last_commit', async () => {
    await withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, async () => {
      const repo = await reset();
      for (let index = 0; index < 26; index++) {
        writeFileSync(join(repo, 'notes', `resume-${index}.md`), `# Resume ${index}\n\nstable ${index}\n`);
      }
      writeFileSync(join(repo, 'notes', 'bad.md'), '---\nslug: definitely-wrong\n---\n# Bad\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'large baseline with one bad file');

      const first = await performSync(engine, {
        repoPath: repo, noPull: true, noEmbed: true, noExtract: true, skipLock: true,
      });
      expect(first.status).toBe('blocked_by_failures');
      expect(await engine.getConfig('sync.last_commit')).toBe('');
      const checkpoint = await engine.executeRaw<{ completed: number }>(
        `SELECT jsonb_array_length(completed_keys)::int AS completed
         FROM op_checkpoints WHERE op = 'sync-full' LIMIT 1`,
      );
      expect(Number(checkpoint[0]?.completed ?? 0)).toBeGreaterThanOrEqual(26);

      const second = await performSync(engine, {
        repoPath: repo, noPull: true, noEmbed: true, noExtract: true, skipLock: true,
      });
      expect(second.status).toBe('blocked_by_failures');
      expect(second.added).toBe(0);
      expect(await engine.getConfig('sync.last_commit')).toBe('');
    });
  }, 120_000);
});
