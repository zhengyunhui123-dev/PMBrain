/**
 * pmbrain sources harden / pull / unharden: git durability for Git sources.
 *
 *   pmbrain sources harden   <id|--all> [--pat-file <p>] [--branch <b>]
 *                                      [--no-cron] [--no-verify] [--dry-run] [--json]
 *   pmbrain sources pull     <id> | --path <dir> [--branch <b>]
 *   pmbrain sources unharden <id>
 *
 * `pull --path` is DB-free for scheduled jobs and is dispatched before the
 * engine opens PGLite.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  hardenBrainRepo,
  unhardenBrainRepo,
  acceptPat,
  type DurabilityReport,
} from '../core/brain-repo-durability.ts';
import { divergenceSafePull, detectDefaultBranch } from '../core/git-remote.ts';
import { existsSync } from 'fs';
import { join } from 'path';

interface SourceRow {
  id: string;
  local_path: string | null;
  config: unknown;
}

function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i !== -1 && i + 1 < args.length) return args[i + 1];
  const pref = `${name}=`;
  const hit = args.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

function configHost(config: unknown): string | null {
  try {
    const url = (config as Record<string, unknown>)?.remote_url;
    if (typeof url === 'string' && url) return new URL(url).hostname;
  } catch {
    // Ignore malformed stored config; it should not broaden --all PAT scope.
  }
  return null;
}

async function loadSourceRows(engine: BrainEngine, id: string | undefined, all: boolean): Promise<SourceRow[]> {
  if (all) {
    return engine.executeRaw<SourceRow>(
      `SELECT id, local_path, config FROM sources WHERE local_path IS NOT NULL ORDER BY id`,
    );
  }
  if (!id) {
    throw new Error('Usage: pmbrain sources harden <id|--all> [--pat-file <p>] [--branch <b>] [--no-cron] [--no-verify] [--dry-run] [--json]');
  }
  return engine.executeRaw<SourceRow>(
    `SELECT id, local_path, config FROM sources WHERE id = $1`,
    [id],
  );
}

export async function runHarden(engine: BrainEngine, args: string[]): Promise<void> {
  const all = args.includes('--all');
  const id = all
    ? undefined
    : args.find((a) => !a.startsWith('--') && a !== flagVal(args, '--pat-file') && a !== flagVal(args, '--branch'));
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const installCron = !args.includes('--no-cron');
  const verify = !args.includes('--no-verify');
  const branch = flagVal(args, '--branch');
  const patFile = flagVal(args, '--pat-file');

  const pat = acceptPat({ patFile });
  for (const w of pat?.warnings ?? []) console.error(`[pmbrain] ${w}`);

  const rows = await loadSourceRows(engine, id, all);
  if (rows.length === 0) {
    console.error(all ? 'No sources with a local_path to harden.' : `Source "${id}" not found.`);
    process.exit(1);
  }

  if (all && pat) {
    const hosts = new Set(rows.map((r) => configHost(r.config)).filter(Boolean));
    if (hosts.size > 1) {
      console.error(`[pmbrain] Refusing --all with one PAT across multiple hosts (${[...hosts].join(', ')}). Harden each source with its own --pat-file.`);
      process.exit(2);
    }
  }

  const reports: DurabilityReport[] = [];
  for (const row of rows) {
    if (!row.local_path || !existsSync(join(row.local_path, '.git'))) {
      console.error(`[${row.id}] skipped: no local git repo at ${row.local_path ?? '(none)'}`);
      continue;
    }
    const report = await hardenBrainRepo({
      repoPath: row.local_path,
      sourceId: row.id,
      branch,
      pat: pat?.token,
      installCron,
      verify,
      dryRun,
      logger: json ? undefined : (line) => console.error(`  ${line}`),
    });
    reports.push(report);
    if (!json) renderReport(report);
  }

  if (json) console.log(JSON.stringify({ reports }, null, 2));
  if (reports.some((r) => r.needs_attention.length > 0)) process.exitCode = 3;
}

function renderReport(r: DurabilityReport): void {
  console.log(`\n[${r.source_id}] durability - ${r.repo_path} (branch ${r.branch})`);
  for (const s of r.steps) {
    const mark = s.status === 'ok' ? 'ok' : s.status === 'fixed' ? 'fix' : s.status === 'skipped' ? 'skip' : 'warn';
    console.log(`  ${mark.padEnd(4)} ${s.step.padEnd(11)} ${s.detail}`);
  }
  if (r.needs_attention.length) {
    console.log('  NEEDS ATTENTION:');
    for (const n of r.needs_attention) console.log(`    - ${n}`);
  }
  console.log(`  clean against origin: ${r.clean_against_origin ? 'yes' : 'no'}`);
}

export async function runPull(engine: BrainEngine | null, args: string[]): Promise<void> {
  const path = flagVal(args, '--path');
  const branchFlag = flagVal(args, '--branch');

  let repoPath: string;
  if (path) {
    repoPath = path;
  } else {
    const id = args.find((a) => !a.startsWith('--') && a !== branchFlag);
    if (!engine || !id) {
      console.error('Usage: pmbrain sources pull <id> | --path <dir> [--branch <b>]');
      process.exit(2);
    }
    const rows = await engine.executeRaw<SourceRow>(
      `SELECT id, local_path, config FROM sources WHERE id = $1`,
      [id],
    );
    if (rows.length === 0 || !rows[0].local_path) {
      console.error(`Source "${id}" not found or has no local_path.`);
      process.exit(1);
    }
    repoPath = rows[0].local_path;
  }

  if (!existsSync(join(repoPath, '.git'))) {
    console.error(`[pmbrain] not a git repo: ${repoPath}`);
    process.exit(1);
  }
  const branch = branchFlag || detectDefaultBranch(repoPath);
  const outcome = divergenceSafePull(repoPath, branch);
  switch (outcome.status) {
    case 'up_to_date':
      console.log(`up to date (${branch})`);
      break;
    case 'advanced':
      console.log(`advanced ${outcome.from.slice(0, 7)} -> ${outcome.to.slice(0, 7)} (${branch})`);
      break;
    case 'skipped_dirty':
      console.log(`skipped: working tree dirty (${branch})`);
      break;
    case 'conflict_aborted':
      console.error(`[pmbrain] ${outcome.detail}`);
      process.exit(3);
  }
}

export async function runUnharden(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: pmbrain sources unharden <id>');
    process.exit(2);
  }
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path, config FROM sources WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) {
    console.error(`Source "${id}" not found.`);
    process.exit(1);
  }
  const steps = await unhardenBrainRepo({
    repoPath: rows[0].local_path ?? '',
    sourceId: rows[0].id,
    logger: (line) => console.error(line),
  });
  for (const s of steps) {
    const mark = s.status === 'fixed' ? 'fix' : 'skip';
    console.log(`  ${mark} ${s.step}: ${s.detail}`);
  }
}
