/**
 * Quick Maintenance regressions (PMBrain).
 *
 * TEST 1–2: failed files must not empty successful pagesAffected / extract.
 * TEST 3–4: by-mention builds deterministic relations + historical catch-up.
 * TEST 5: embed resume leaves completed embeddings (stale query).
 * TEST 6–7: Full / Meeting phase order unchanged; Quick uses thin entry.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveDreamPresetPhases } from '../src/commands/dream.ts';
import {
  resolveQuickMaintenancePhases,
  runQuickMaintenance,
  QUICK_BY_MENTION_HISTORICAL_DEFAULT,
} from '../src/core/quick-maintenance.ts';
import { ALL_PHASES } from '../src/core/cycle.ts';
import { runByMentionCore } from '../src/commands/extract.ts';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-quick-maint-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, 'people'), { recursive: true });
  mkdirSync(join(dir, 'companies'), { recursive: true });
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commitAll(repo: string, message: string): void {
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: repo, stdio: 'pipe' });
}

function goodPerson(title: string, body = 'body'): string {
  return ['---', `type: person`, `title: ${title}`, '---', '', body, ''].join('\n');
}

function goodNote(title: string, body: string): string {
  return ['---', 'type: note', `title: ${title}`, '---', '', body, ''].join('\n');
}

function badSlugPerson(title: string): string {
  return [
    '---',
    'type: person',
    `title: ${title}`,
    'slug: totally-wrong-slug',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

describe('Quick Maintenance phase contracts (TEST 6–7)', () => {
  test('Quick phase order matches legacy preset and stays a subset of ALL_PHASES', () => {
    const quick = resolveQuickMaintenancePhases();
    expect(quick).toEqual(resolveDreamPresetPhases('quick'));
    expect(quick).toEqual([
      'lint',
      'backlinks',
      'sync',
      'extract',
      'extract_facts',
      'resolve_symbol_edges',
      'embed',
      'orphans',
    ]);
    // Ordering source remains ALL_PHASES
    let lastIdx = -1;
    for (const p of quick) {
      const idx = ALL_PHASES.indexOf(p);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test('Full Dream still uses full ALL_PHASES set', () => {
    expect(resolveDreamPresetPhases('full')).toEqual([...ALL_PHASES]);
  });

  test('Meeting preset phase order unchanged', () => {
    expect(resolveDreamPresetPhases('meeting')).toEqual([
      'synthesize',
      'extract',
      'extract_facts',
      'extract_atoms',
      'resolve_symbol_edges',
      'embed',
    ]);
  });

  test('dream quick entry wires runQuickMaintenance', async () => {
    const source = await Bun.file(new URL('../src/commands/dream.ts', import.meta.url)).text();
    expect(source).toContain("opts.preset === 'quick'");
    expect(source).toContain('runQuickMaintenance');
    expect(source).toContain('../core/quick-maintenance.ts');
  });

  test('default historical by-mention budget is finite and positive', () => {
    expect(QUICK_BY_MENTION_HISTORICAL_DEFAULT).toBeGreaterThan(0);
    expect(QUICK_BY_MENTION_HISTORICAL_DEFAULT).toBeLessThanOrEqual(5000);
  });
});

describe('sync failure isolation (TEST 1–2)', () => {
  let repo: string;
  let engine: PGLiteEngine;
  let failuresPath: string | null = null;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-home-'));
    process.env.PMBRAIN_HOME = home;
    process.env.GBRAIN_HOME = home;
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
    delete process.env.PMBRAIN_HOME;
    delete process.env.GBRAIN_HOME;
  }, 60_000);

  beforeEach(async () => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    repo = makeGitRepo();
    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw('DELETE FROM content_chunks');
    await engine.executeRaw('DELETE FROM pages');
    // Clear sync anchors between cases
    try {
      await engine.setConfig('sync.last_commit', '');
      await engine.setConfig('sync.repo_path', '');
    } catch { /* ignore */ }
  });

  test('TEST 1: historical bad file B + new good file A → pagesAffected includes A', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    // Baseline first sync
    writeFileSync(join(repo, 'people/alice.md'), goodPerson('Alice Example'));
    commitAll(repo, 'add alice');
    let result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
    expect(['first_sync', 'synced']).toContain(result.status);
    const anchor = await engine.getConfig('sync.last_commit');
    expect(anchor).toBeTruthy();

    // Bad B blocks; good A still lands in pagesAffected
    writeFileSync(join(repo, 'people/bad-bob.md'), badSlugPerson('Bad Bob'));
    writeFileSync(join(repo, 'notes/good-a.md'), goodNote('Good A', 'Today I researched things.'));
    commitAll(repo, 'add bad B and good A');

    result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
    expect(result.status).toBe('blocked_by_failures');
    expect(result.failedFiles).toBeGreaterThan(0);
    const affected = result.pagesAffected ?? [];
    expect(affected.some(s => s.includes('good-a') || s.includes('notes/good-a'))).toBe(true);
    expect(await engine.getConfig('sync.last_commit')).toBe(anchor);
    const page = await engine.getPage('notes/good-a')
      ?? await engine.getPage(affected.find(s => s.includes('good')) ?? '');
    expect(page).not.toBeNull();
  }, 60_000);

  test('TEST 2: 20 good + 1 bad → pagesAffected non-empty (not [])', async () => {
    const { performSync } = await import('../src/commands/sync.ts');

    writeFileSync(join(repo, 'people/seed.md'), goodPerson('Seed Person'));
    commitAll(repo, 'seed');
    await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });

    // 20 is enough to prove non-empty isolation without slow imports
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(repo, `notes/n${String(i).padStart(3, '0')}.md`),
        goodNote(`Note ${i}`, `Body of note ${i}`),
      );
    }
    writeFileSync(join(repo, 'people/broken.md'), badSlugPerson('Broken'));
    commitAll(repo, '20 good + 1 bad');

    const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
    expect(result.status).toBe('blocked_by_failures');
    expect(result.pagesAffected.length).toBeGreaterThan(0);
    expect(result.pagesAffected.length).toBeGreaterThanOrEqual(15);
    expect(result.failedFiles).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test('full sync blocked still returns importedSlugs as pagesAffected', async () => {
    writeFileSync(join(repo, 'people/ok.md'), goodPerson('Ok Person'));
    writeFileSync(join(repo, 'people/bad.md'), badSlugPerson('Bad Person'));
    commitAll(repo, 'mixed first tree');

    await engine.setConfig('sync.last_commit', '');
    await engine.setConfig('sync.repo_path', '');

    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
    expect(result.status).toBe('blocked_by_failures');
    expect(result.pagesAffected.length).toBeGreaterThan(0);
    expect(result.failedFiles).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('by-mention relations (TEST 3–4)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw('DELETE FROM op_checkpoints').catch(() => {});
  });

  test('TEST 3: body mention of existing entities creates mentions links', async () => {
    await engine.putPage('companies/openai', {
      type: 'company',
      title: 'OpenAI',
      compiled_truth: 'AI lab',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('entities/codex', {
      type: 'entity',
      title: 'Codex',
      compiled_truth: 'coding agent',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('notes/today', {
      type: 'note',
      title: 'Today',
      compiled_truth: '今天研究了 OpenAI 的 Codex。',
      timeline: '',
      frontmatter: {},
    });

    const r = await runByMentionCore(engine, { quiet: true });
    expect(r.created).toBeGreaterThanOrEqual(2);
    expect(r.pages).toBeGreaterThan(0);

    const rows = await engine.executeRaw<{ from_slug: string; to_slug: string; ls: string }>(
      `SELECT fp.slug AS from_slug, tp.slug AS to_slug, l.link_source AS ls
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
       WHERE l.link_source = 'mentions'`,
    );
    const targets = new Set(rows.map(r => r.to_slug));
    expect(targets.has('companies/openai')).toBe(true);
    expect(targets.has('entities/codex')).toBe(true);
    expect(rows.every(r => r.from_slug === 'notes/today')).toBe(true);
  });

  test('TEST 4: historical catch-up with maxHistoricalPages processes backlog gradually', async () => {
    await engine.putPage('companies/acme-corp', {
      type: 'company',
      title: 'Acme Corp',
      compiled_truth: 'corp',
      timeline: '',
      frontmatter: {},
    });
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`notes/hist-${i}`, {
        type: 'note',
        title: `Hist ${i}`,
        compiled_truth: `We met Acme Corp number ${i}.`,
        timeline: '',
        frontmatter: {},
      });
    }

    const first = await runByMentionCore(engine, {
      quiet: true,
      maxHistoricalPages: 2,
    });
    expect(first.pages).toBeLessThanOrEqual(2);
    expect(first.historicalRemaining).toBeGreaterThan(0);

    const second = await runByMentionCore(engine, {
      quiet: true,
      maxHistoricalPages: 10,
    });
    // Remaining historical should drain (or shrink)
    expect(second.historicalRemaining).toBeLessThan(first.historicalRemaining);

    const links = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM links WHERE link_source = 'mentions'`,
    );
    expect(Number(links[0]?.c ?? 0)).toBeGreaterThan(0);
  });

  test('prioritySlugs re-scan even when already checkpointed', async () => {
    await engine.putPage('companies/acme-corp', {
      type: 'company',
      title: 'Acme Corp',
      compiled_truth: 'corp',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('notes/p1', {
      type: 'note',
      title: 'P1',
      compiled_truth: 'No entity here.',
      timeline: '',
      frontmatter: {},
    });

    await runByMentionCore(engine, { quiet: true, maxHistoricalPages: 100 });
    // Update body to mention entity after first scan
    await engine.putPage('notes/p1', {
      type: 'note',
      title: 'P1',
      compiled_truth: 'Now mentions Acme Corp clearly.',
      timeline: '',
      frontmatter: {},
    });

    const r = await runByMentionCore(engine, {
      quiet: true,
      prioritySlugs: ['notes/p1'],
      maxHistoricalPages: 0,
    });
    expect(r.pages).toBeGreaterThanOrEqual(1);
    const links = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM links WHERE link_source = 'mentions'`,
    );
    expect(Number(links[0]?.c ?? 0)).toBeGreaterThan(0);
  });
});

describe('embed resume semantics (TEST 5)', () => {
  test('embed --stale selects embedding IS NULL (resume-safe, no full restart)', async () => {
    // Contract-level: completed vectors stay written; next Quick only
    // walks NULL embeddings. Full re-embed is not the default path.
    const embedSrc = await Bun.file(new URL('../src/commands/embed.ts', import.meta.url)).text();
    expect(embedSrc).toContain('embedding IS NULL');
    expect(embedSrc).toContain('countStaleChunks');
    expect(embedSrc).toContain('listStaleChunks');
    // Wall-clock budget exits cleanly so partial progress is kept
    expect(embedSrc).toMatch(/wall-clock budget|budgetController|budgetMs/);
    // catch-up removes the cap for full drain when explicitly requested
    expect(embedSrc).toContain('catchUp');
  });
});

describe('runQuickMaintenance orchestration smoke', () => {
  let repo: string;
  let engine: PGLiteEngine;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-orch-'));
    process.env.PMBRAIN_HOME = home;
    process.env.GBRAIN_HOME = home;
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
    delete process.env.PMBRAIN_HOME;
    delete process.env.GBRAIN_HOME;
  }, 60_000);

  test('quick run includes extract with by_mention details and keeps full phase list', async () => {
    repo = makeGitRepo();
    writeFileSync(join(repo, 'companies/openai.md'), [
      '---', 'type: company', 'title: OpenAI', '---', '', 'AI company.', '',
    ].join('\n'));
    writeFileSync(join(repo, 'notes/research.md'), goodNote(
      'Research',
      'Today I studied OpenAI carefully.',
    ));
    commitAll(repo, 'seed for quick');

    const report = await runQuickMaintenance(engine, {
      brainDir: repo,
      dryRun: false,
      pull: false,
      byMentionMaxHistorical: 50,
    });

    expect(report.phases.map(p => p.phase)).toEqual([
      'lint',
      'backlinks',
      'sync',
      'extract',
      'extract_facts',
      'resolve_symbol_edges',
      'embed',
      'orphans',
    ]);
    const extract = report.phases.find(p => p.phase === 'extract');
    expect(extract).toBeTruthy();
    expect(extract!.details.by_mention).toBe(true);
    // Full Dream phases like synthesize/patterns must not appear
    expect(report.phases.some(p => p.phase === 'synthesize')).toBe(false);
    expect(report.phases.some(p => p.phase === 'patterns')).toBe(false);
  }, 120_000);
});
