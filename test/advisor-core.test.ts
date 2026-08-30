import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { COLLECTORS, rankFindings, runAdvisor } from '../src/core/advisor/run.ts';
import { collectUsageShape } from '../src/core/advisor/collect-usage-shape.ts';
import { collectStalledJobs } from '../src/core/advisor/collect-stalled-jobs.ts';
import { collectSetupSmells } from '../src/core/advisor/collect-setup-smells.ts';
import { collectBackupCoverage } from '../src/core/advisor/collect-backup-coverage.ts';
import { collectMcpClientFit } from '../src/core/advisor/collect-mcp-client-fit.ts';
import { collectUninstalledBundled } from '../src/core/advisor/collect-uninstalled-bundled.ts';
import { pendingCachedUpgradeVersion } from '../src/core/advisor/collect-version.ts';
import { appendAdvisorRun, summarizeDeltas } from '../src/core/advisor/history.ts';
import { renderAdvisorReport } from '../src/core/advisor/render.ts';
import type { AdvisorContext, AdvisorFinding, AdvisorReport } from '../src/core/advisor/types.ts';

function finding(over: Partial<AdvisorFinding>): AdvisorFinding {
  return { id: 'x', severity: 'info', title: 't', fix: { command_argv: null }, collector: 'usage-shape', ask_user: true, ...over };
}

function ctx(engine: Partial<AdvisorContext['engine']>, over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine: engine as AdvisorContext['engine'],
    config: {} as AdvisorContext['config'],
    version: '1.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-26T00:00:00Z'),
    remote: false,
    ...over,
  };
}

describe('rankFindings', () => {
  test('critical > warn > info, then collector order', () => {
    const ranked = rankFindings([
      finding({ id: 'i1', severity: 'info', collector: 'usage-shape' }),
      finding({ id: 'c1', severity: 'critical', collector: 'migration' }),
      finding({ id: 'w1', severity: 'warn', collector: 'schema-pack' }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(['c1', 'w1', 'i1']);
  });

  test('info cap drops extra info but keeps criticals', () => {
    const fs: AdvisorFinding[] = [];
    for (let i = 0; i < 15; i++) fs.push(finding({ id: `i${i}`, severity: 'info' }));
    fs.push(finding({ id: 'crit', severity: 'critical', collector: 'migration' }));
    const ranked = rankFindings(fs, { infoCap: 3 });
    expect(ranked.filter((f) => f.severity === 'info')).toHaveLength(3);
    expect(ranked.find((f) => f.id === 'crit')).toBeDefined();
  });
});

describe('runAdvisor resilience', () => {
  test('does not throw when collectors hit engine errors', async () => {
    const engine = {
      getStats: async () => { throw new Error('boom'); },
      getHealth: async () => { throw new Error('boom'); },
      getConfig: async () => { throw new Error('boom'); },
      executeRaw: async () => { throw new Error('boom'); },
      findOrphanPages: async () => { throw new Error('boom'); },
    };
    const report = await runAdvisor(ctx(engine));
    expect(Array.isArray(report.findings)).toBe(true);
  });

  test('drops workspace-dependent findings over MCP', async () => {
    const report = await runAdvisor(ctx({
      getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
    }, { remote: true }));
    expect(report.findings.every((item) => !item.workspace_dependent)).toBe(true);
  });

  test('adds only the PM-applicable GBrain Advisor collectors', () => {
    expect(COLLECTORS.map((item) => item.id)).toEqual([
      'version',
      'migration',
      'schema-pack',
      'stalled-jobs',
      'usage-shape',
      'setup-smells',
      'uninstalled-bundled',
      'mcp-client-fit',
      'backup-coverage',
    ]);
  });
});

describe('collectors', () => {
  test('usage shape flags missing chunks and policy-filtered orphans, and offers stale embed', async () => {
    const engine = {
      getStats: async () => ({ page_count: 100, chunk_count: 200, embedded_count: 32, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
      getHealth: async () => ({
        page_count: 100,
        embed_coverage: 0.4,
        stale_pages: 0,
        orphan_pages: 50,
        missing_embeddings: 168,
        brain_score: 50,
        dead_links: 0,
        link_coverage: 0,
        timeline_coverage: 0,
        most_connected: [],
        embed_coverage_score: 0,
        link_density_score: 0,
        timeline_coverage_score: 0,
        no_orphans_score: 0,
        no_dead_links_score: 0,
      }),
      getConfig: async () => null,
      executeRaw: async () => [{ pending: 168 }],
      findOrphanPages: async () => [
        { slug: 'wiki/people/alice', title: 'Alice', domain: 'wiki' },
        { slug: 'youdao/mirror', title: 'Youdao', domain: 'youdao' },
        { slug: 'output/summary', title: 'Output', domain: 'output' },
      ],
    };
    const out = await collectUsageShape.collect(ctx(engine as never, {
      config: { embedding_model: 'ollama:nomic', embedding_dimensions: 768 } as AdvisorContext['config'],
    }));
    const embed = out.find((f) => f.id === 'low_embed_coverage');
    expect(embed?.title).toContain('168 chunks');
    expect(embed?.fix.dispatch_id).toBe('embed_stale');
    expect(embed?.fix.command_argv).toEqual(['pmbrain', 'embed', '--stale']);
    const orphans = out.find((f) => f.id === 'orphan_pages');
    expect(orphans?.title).toContain('1 knowledge pages');
    expect(orphans?.fix.dispatch_id).toBe('organize_orphans');
  });

  test('usage shape does not offer embed-now when vectors are not configured', async () => {
    const engine = {
      getStats: async () => ({ page_count: 10, chunk_count: 10, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
      getHealth: async () => ({
        page_count: 10,
        embed_coverage: 0,
        stale_pages: 0,
        orphan_pages: 0,
        missing_embeddings: 10,
        brain_score: 50,
        dead_links: 0,
        link_coverage: 0,
        timeline_coverage: 0,
        most_connected: [],
        embed_coverage_score: 0,
        link_density_score: 0,
        timeline_coverage_score: 0,
        no_orphans_score: 0,
        no_dead_links_score: 0,
      }),
      getConfig: async () => null,
      executeRaw: async () => [{ pending: 10 }],
      findOrphanPages: async () => [],
    };
    const out = await collectUsageShape.collect(ctx(engine as never));
    expect(out.map((f) => f.id)).not.toContain('low_embed_coverage');
  });

  test('stalled jobs collector tolerates absent table', async () => {
    const engine = { executeRaw: async () => { throw new Error('missing'); } };
    expect(await collectStalledJobs.collect(ctx(engine as never))).toEqual([]);
  });

  test('setup smells flags disabled embeddings', async () => {
    const engine = { getConfig: async () => null };
    const out = await collectSetupSmells.collect(ctx(engine as never, { config: { embedding_disabled: true } as AdvisorContext['config'] }));
    expect(out.find((f) => f.id === 'embeddings_disabled')).toBeDefined();
  });

  test('setup smells asks for embedding_model and dimensions, never ZeroEntropy', async () => {
    const engine = { getConfig: async () => null };
    const out = await collectSetupSmells.collect(ctx(engine as never, { config: {} as AdvisorContext['config'] }));
    expect(out.find((f) => f.id === 'embedding_not_configured')).toBeDefined();
    expect(out.find((f) => f.id === 'embedding_key_missing')).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/zeroentropy/i);
    const configured = await collectSetupSmells.collect(ctx(engine as never, {
      config: { embedding_model: 'ollama:nomic', embedding_dimensions: 768 } as AdvisorContext['config'],
    }));
    expect(configured.find((f) => f.id === 'embedding_not_configured')).toBeUndefined();
  });

  test('backup coverage warns for populated PGLite without a verified backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisor-backup-empty-'));
    const databasePath = join(dir, 'brain.pglite');
    const backupRoot = join(dir, 'backups');
    mkdirSync(databasePath);
    try {
      const out = await collectBackupCoverage.collect(ctx({
        getStats: async () => ({ page_count: 8 }),
      } as never, {
        config: { engine: 'pglite', database_path: databasePath, pglite_upgrade_backup_dir: backupRoot } as AdvisorContext['config'],
      }));
      expect(out.map((item) => item.id)).toEqual(['backup_pglite_missing']);
      expect(out[0]?.fix.command_argv).toEqual(['pmbrain', 'pglite-backup', 'create', '--target-version', '1.0.0']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('backup coverage stays quiet for a recent verified backup and warns when it is stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisor-backup-age-'));
    const databasePath = join(dir, 'brain.pglite');
    const backupRoot = join(dir, 'backups');
    const backupDirectory = join(backupRoot, 'verified-copy');
    const backupDatabasePath = join(backupDirectory, 'brain.pglite');
    mkdirSync(databasePath);
    mkdirSync(backupDatabasePath, { recursive: true });
    const manifestPath = join(backupDirectory, 'manifest.json');
    const writeManifest = (createdAt: string) => writeFileSync(manifestPath, JSON.stringify({
      manifest_version: 1,
      backup_id: 'verified-copy',
      status: 'verified',
      created_at: createdAt,
      source_database_path: databasePath,
      backup_database_path: backupDatabasePath,
      target_version: '1.0.0',
      source_schema_version: 119,
      source_inventory: { files: 1, bytes: 1, sha256: 'a' },
      backup_inventory: { files: 1, bytes: 1, sha256: 'a' },
      recovery_validation: { status: 'verified', verified_at: createdAt, schema_version: 119, protected_table_counts: { pages: 8 } },
      data_policy_version: 1,
      rebuildable_artifacts: [],
    }));
    const context = ctx({ getStats: async () => ({ page_count: 8 }) } as never, {
      config: { engine: 'pglite', database_path: databasePath, pglite_upgrade_backup_dir: backupRoot } as AdvisorContext['config'],
    });
    try {
      writeManifest('2026-06-20T00:00:00.000Z');
      expect(await collectBackupCoverage.collect(context)).toEqual([]);
      writeManifest('2026-05-01T00:00:00.000Z');
      expect((await collectBackupCoverage.collect(context)).map((item) => item.id)).toEqual(['backup_pglite_stale']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('MCP client fit reports sustained failures and redacts client identity remotely', async () => {
    const engine = {
      executeRaw: async () => [{
        client_id: 'desktop-workbuddy', client_name: 'WorkBuddy', total_calls: 20,
        failed_calls: 8, successful_calls: 12, last_seen: '2026-06-25T00:00:00.000Z',
      }],
    };
    const local = await collectMcpClientFit.collect(ctx(engine as never));
    expect(local[0]?.id).toBe('mcp_client_unhealthy:desktop-workbuddy');
    expect(local[0]?.title).toContain('WorkBuddy');
    const remote = await collectMcpClientFit.collect(ctx(engine as never, { remote: true }));
    expect(remote[0]?.id).toBe('mcp_client_unhealthy_aggregate');
    expect(JSON.stringify(remote)).not.toContain('desktop-workbuddy');
    expect(JSON.stringify(remote)).not.toContain('WorkBuddy');
  });

  test('MCP client fit ignores low-volume noise and fails silently when logs are unavailable', async () => {
    const lowVolume = await collectMcpClientFit.collect(ctx({
      executeRaw: async () => [{
        client_id: 'client-a', client_name: 'Client A', total_calls: 4,
        failed_calls: 4, successful_calls: 0, last_seen: '2026-06-25T00:00:00.000Z',
      }],
    } as never));
    expect(lowVolume).toEqual([]);
    expect(await collectMcpClientFit.collect(ctx({
      executeRaw: async () => { throw new Error('missing table'); },
    } as never))).toEqual([]);
  });

  test('bundled skill collector repeats the current recommendation outside remote surfaces', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'advisor-skills-'));
    const skillsDir = join(workspace, 'skills');
    mkdirSync(skillsDir);
    writeFileSync(join(skillsDir, 'RESOLVER.md'), '# RESOLVER\n');
    try {
      const local = await collectUninstalledBundled.collect(ctx({} as never, { workspace, skillsDir }));
      expect(local[0]?.id).toBe('uninstalled_bundled_skills');
      expect(local[0]?.detail).toContain('cold-start');
      expect(local[0]?.fix.command_argv?.slice(0, 3)).toEqual(['pmbrain', 'skillpack', 'install']);
      expect(await collectUninstalledBundled.collect(ctx({} as never, { workspace, skillsDir, remote: true }))).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('version cache and history', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('version collector stays silent without a fresh local cache', () => {
    expect(pendingCachedUpgradeVersion('1.3.10', Date.parse('2026-08-29T00:00:00Z'), { path: join(tmpdir(), 'missing-update-check.json') })).toBeNull();
  });

  test('version collector reads a fresh cache and ignores stale or older versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisor-update-'));
    dirs.push(dir);
    const path = join(dir, 'update-check.json');
    writeFileSync(path, JSON.stringify({ latest: '1.3.12', checked_at: '2026-08-28T00:00:00.000Z' }));
    expect(pendingCachedUpgradeVersion('1.3.10', Date.parse('2026-08-29T00:00:00Z'), { path })).toBe('1.3.12');
    writeFileSync(path, JSON.stringify({ latest: '1.3.9', checked_at: '2026-08-28T00:00:00.000Z' }));
    expect(pendingCachedUpgradeVersion('1.3.10', Date.parse('2026-08-29T00:00:00Z'), { path })).toBeNull();
    writeFileSync(path, JSON.stringify({ latest: '1.4.0', checked_at: '2026-01-01T00:00:00.000Z' }));
    expect(pendingCachedUpgradeVersion('1.3.10', Date.parse('2026-08-29T00:00:00Z'), { path })).toBeNull();
  });

  test('history reports new and resolved finding ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisor-history-'));
    dirs.push(dir);
    const path = join(dir, 'advisor-history.jsonl');
    const first: AdvisorReport = {
      version: '1.3.11',
      generated_at: '2026-08-28T00:00:00.000Z',
      worst: 'warn',
      findings: [finding({ id: 'low_embed_coverage' })],
    };
    expect(appendAdvisorRun(first, { path })).toBeNull();
    const second: AdvisorReport = {
      version: '1.3.11',
      generated_at: '2026-08-29T00:00:00.000Z',
      worst: 'info',
      findings: [finding({ id: 'orphan_pages' })],
    };
    const prior = appendAdvisorRun(second, { path });
    expect(summarizeDeltas(prior, second)).toContain('1 new since last run');
    expect(summarizeDeltas(prior, second)).toContain('1 resolved');
  });
});

describe('renderAdvisorReport', () => {
  test('healthy report renders all-clear', () => {
    const txt = renderAdvisorReport({ version: '1.0.0', generated_at: 'x', findings: [], worst: null });
    expect(txt).toContain('looks healthy');
  });
});
