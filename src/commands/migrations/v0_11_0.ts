/**
 * v0.11.0 migration orchestrator — GBrain Minions adoption.
 *
 * Phases (all idempotent; resumable from a prior status:"partial" run):
 *   A. Schema  — in-process schema migration for all engines. Never shells
 *                out to pmbrain/gbrain; desktop installers cannot rely on PATH.
 *   B. Smoke   — in-process jobs table smoke.
 *   C. Mode    — resolve minion_mode (flag / default / TTY prompt).
 *   D. Prefs   — write preferences.json in the active PMBrain home.
 *   E. Host    — detect AGENTS.md + cron manifests. Inject the subagent-
 *                routing convention marker into each AGENTS.md. Rewrite
 *                cron entries for PMBrain built-in handler names only.
 *                For non-builtin handlers (host-specific, like
 *                ea-inbox-sweep) emit structured TODO rows to
 *                migrations/pending-host-work.jsonl so the host
 *                agent can walk through its plugin-contract work per
 *                skills/migrations/v0.11.0.md.
 *   F. Install — intentionally skipped; migrations must not invoke CLI tools.
 *   G. Record  — append completed.jsonl (status: complete unless any
 *                pending-host-work items remain).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, lstatSync, statSync, realpathSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { savePreferences, loadPreferences } from '../../core/preferences.ts';
// Bug 3 — appendCompletedMigration moved to the runner (apply-migrations.ts).
import { promptLine } from '../../core/cli-util.ts';
import { VERSION } from '../../version.ts';
import { createMigrationEngine, closeMigrationEngine, runSchemaMigration } from './helpers.ts';

const BUILTIN_HANDLERS = new Set(['sync', 'embed', 'lint', 'import', 'extract', 'backlinks', 'autopilot-cycle']);
const AGENTS_MD_MARKER = '<!-- pmbrain:subagent-routing v0.11.0 -->';
const CRON_MIGRATED_PROPERTY = '_pmbrain_migrated_by';
const MAX_HOST_FILE_BYTES = 1_000_000;

function home(): string { return process.env.HOME || ''; }
function pendingHostWorkPath(): string { return gbrainPath('migrations', 'pending-host-work.jsonl'); }

export interface PendingHostWorkEntry {
  type: 'cron-handler-needs-host-registration' | 'agents-md-dispatcher-needs-host-review';
  status: 'pending' | 'complete';
  detected_at: string;
  /** For cron-handler type. */
  handler?: string;
  cron_schedule?: string;
  manifest_path?: string;
  current_cmd?: string;
  /** For agents-md type. */
  file?: string;
  detected_patterns?: string[];
  recommendation: string;
}

// -----------------------------------------------------------------------
// Phase A — Schema
// -----------------------------------------------------------------------

async function phaseASchema(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  return runSchemaMigration(opts);
}

// -----------------------------------------------------------------------
// Phase B — Smoke
// -----------------------------------------------------------------------

async function phaseBSmoke(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'smoke', status: 'skipped', detail: 'dry-run' };
  let eng: Awaited<ReturnType<typeof createMigrationEngine>> | null = null;
  try {
    eng = await createMigrationEngine();
    await eng.executeRaw(`SELECT 1`);
    const tables = await eng.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('jobs', 'job_events')`,
    );
    const names = new Set(tables.map(t => t.table_name));
    if (!names.has('jobs')) {
      return { name: 'smoke', status: 'failed', detail: 'jobs table missing after schema migration' };
    }
    return {
      name: 'smoke',
      status: 'complete',
      detail: names.has('job_events') ? 'jobs tables reachable' : 'jobs table reachable',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'smoke', status: 'failed', detail: msg };
  } finally {
    if (eng) await closeMigrationEngine(eng);
  }
}

// -----------------------------------------------------------------------
// Phase C — Mode resolution
// -----------------------------------------------------------------------

async function phaseCMode(opts: OrchestratorOpts): Promise<{
  phase: OrchestratorPhaseResult;
  mode: 'always' | 'pain_triggered' | 'off';
}> {
  // Explicit flag wins.
  if (opts.mode) {
    return { phase: { name: 'mode', status: 'complete', detail: `mode=${opts.mode}` }, mode: opts.mode };
  }
  // If already set in preferences (resume from a partial run), respect it.
  const existing = loadPreferences();
  if (existing.minion_mode) {
    return { phase: { name: 'mode', status: 'complete', detail: `mode=${existing.minion_mode} (preserved)` }, mode: existing.minion_mode };
  }

  // --yes / non-TTY: explicit pain_triggered default with a visible print.
  if (opts.yes || !process.stdin.isTTY) {
    console.log('Defaulting minion_mode=pain_triggered (non-interactive). Change with `pmbrain config set minion_mode <always|off>`.');
    return { phase: { name: 'mode', status: 'complete', detail: 'mode=pain_triggered (default)' }, mode: 'pain_triggered' };
  }

  // Interactive: numbered menu via the shared promptLine helper.
  console.log('');
  console.log('How should your agent use GBrain Minions?');
  console.log('  [1] always          — route every background agent task through Minions (most durable)');
  console.log('  [2] pain_triggered  — default to native subagents, switch to Minions when pain signals fire (recommended)');
  console.log('  [3] off             — disable Minions; keep native subagents');
  console.log('');
  const answer = (await promptLine('Choice [2]: ')).trim() || '2';
  const mode = answer === '1' ? 'always' : answer === '3' ? 'off' : 'pain_triggered';
  return { phase: { name: 'mode', status: 'complete', detail: `mode=${mode}` }, mode };
}

// -----------------------------------------------------------------------
// Phase D — Preferences
// -----------------------------------------------------------------------

function phaseDPrefs(mode: 'always' | 'pain_triggered' | 'off', opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'prefs', status: 'skipped', detail: `would write mode=${mode}` };
  try {
    savePreferences({
      minion_mode: mode,
      set_at: new Date().toISOString(),
      set_in_version: VERSION.replace(/^v/, '').trim() || '0.11.0',
    });
    return { name: 'prefs', status: 'complete' };
  } catch (e) {
    return { name: 'prefs', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// -----------------------------------------------------------------------
// Phase E — Host manifest rewrites + JSONL TODOs
// -----------------------------------------------------------------------

function hostScopes(opts: OrchestratorOpts): string[] {
  const scopes = [join(home(), '.claude'), join(home(), '.openclaw')];
  if (opts.hostDir) scopes.push(resolve(opts.hostDir));
  return scopes.filter(p => existsSync(p));
}

function safeReadHostFile(path: string): { content: string; skipReason?: string } {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const resolved = realpathSync(path);
      // Skip if the symlink target escapes the scoped roots.
      const scopedRoots = [join(home(), '.claude'), join(home(), '.openclaw')];
      if (!scopedRoots.some(root => resolved.startsWith(root))) {
        return { content: '', skipReason: `symlink target outside scoped root: ${resolved}` };
      }
    }
    const fileStats = statSync(path);
    if (fileStats.size > MAX_HOST_FILE_BYTES) {
      return { content: '', skipReason: `file > ${MAX_HOST_FILE_BYTES} bytes` };
    }
    return { content: readFileSync(path, 'utf-8') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('EACCES') || msg.includes('permission')) {
      return { content: '', skipReason: `permission denied` };
    }
    return { content: '', skipReason: `read failed: ${msg}` };
  }
}

function injectAgentsMdMarker(path: string, opts: OrchestratorOpts): { injected: boolean; skipReason?: string } {
  const { content, skipReason } = safeReadHostFile(path);
  if (skipReason) return { injected: false, skipReason };
  if (content.includes(AGENTS_MD_MARKER)) return { injected: false, skipReason: 'already has marker' };

  if (opts.dryRun) return { injected: true, skipReason: 'dry-run' };

  // mtime re-check immediately before write.
  const beforeMtime = statSync(path).mtimeMs;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${path}.bak.${stamp}`;
  try {
    writeFileSync(bakPath, content);
    const snippet = `\n\n${AGENTS_MD_MARKER}\n## Subagent routing (PMBrain v0.11.0)\n\nSee \`skills/conventions/subagent-routing.md\` for the runtime routing convention.\nThe active PMBrain home's \`preferences.json\` controls \`minion_mode\` (always / pain_triggered / off).\n`;
    // Re-check mtime
    const nowMtime = statSync(path).mtimeMs;
    if (nowMtime !== beforeMtime) {
      return { injected: false, skipReason: 'file modified between read and write — skipping; re-run to retry' };
    }
    writeFileSync(path, content.trimEnd() + snippet);
    return { injected: true };
  } catch (e) {
    return { injected: false, skipReason: `write failed: ${e instanceof Error ? e.message : e}` };
  }
}

function findAgentsMdFiles(opts: OrchestratorOpts): string[] {
  const found: string[] = [];
  for (const scope of hostScopes(opts)) {
    const candidate = join(scope, 'AGENTS.md');
    if (existsSync(candidate)) found.push(candidate);
  }
  // Also check $HOME/AGENTS.md and $PWD/AGENTS.md when --host-dir passed.
  if (opts.hostDir) {
    const c = join(resolve(opts.hostDir), 'AGENTS.md');
    if (existsSync(c) && !found.includes(c)) found.push(c);
  }
  return found;
}

function findCronManifests(opts: OrchestratorOpts): string[] {
  const found: string[] = [];
  for (const scope of hostScopes(opts)) {
    const candidates = [
      join(scope, 'cron', 'jobs.json'),
      join(scope, 'cron.json'),
    ];
    for (const c of candidates) if (existsSync(c)) found.push(c);
  }
  return found;
}

function rewriteCronManifest(
  path: string,
  opts: OrchestratorOpts,
): { rewritten: number; todos_emitted: number; skipReason?: string } {
  const { content, skipReason } = safeReadHostFile(path);
  if (skipReason) return { rewritten: 0, todos_emitted: 0, skipReason };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { rewritten: 0, todos_emitted: 0, skipReason: `malformed JSON: ${e instanceof Error ? e.message : e}` };
  }

  const entries = Array.isArray(parsed) ? parsed : (parsed as { jobs?: unknown[] }).jobs;
  if (!Array.isArray(entries)) {
    return { rewritten: 0, todos_emitted: 0, skipReason: 'no entries array (expected Array or { jobs: [...] })' };
  }

  const pendingEntries: PendingHostWorkEntry[] = [];
  let rewritten = 0;
  let changed = false;

  // Detect engine for --follow branch (PGLite needs --follow because its
  // worker daemon can't run; Postgres drops --follow + uses idempotency key).
  // We load config lazily to avoid a hard dep.
  let enginePglite = false;
  try {
    const cfg = loadConfig();
    enginePglite = cfg?.engine === 'pglite';
  } catch { /* best-effort */ }

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    if ((entry as any)[CRON_MIGRATED_PROPERTY]) continue; // idempotency

    const kind = typeof entry.kind === 'string' ? entry.kind : undefined;
    const handler = (typeof entry.skill === 'string' ? entry.skill : undefined)
      || (typeof entry.handler === 'string' ? entry.handler : undefined)
      || (typeof entry.name === 'string' ? entry.name : undefined);
    const schedule = typeof entry.schedule === 'string' ? entry.schedule : (typeof entry.cron === 'string' ? entry.cron : '<unknown>');

    if (kind !== 'agentTurn' && kind !== 'session' && kind !== 'skill') continue;
    if (!handler) continue;

    if (BUILTIN_HANDLERS.has(handler)) {
      // Rewrite to shell + pmbrain jobs submit.
      let cmd: string;
      if (enginePglite) {
        cmd = `pmbrain jobs submit ${handler} --params '{}' --follow`;
      } else {
        // slot computed via date(1). Host scheduler evaluates shell.
        cmd = `pmbrain jobs submit ${handler} --params '{"slot":"$(date -u +%Y-%m-%dT%H:%M)"}' --idempotency-key ${handler}:$(date -u +%Y-%m-%dT%H:%M)`;
      }
      entry.kind = 'shell';
      entry.cmd = cmd;
      (entry as any)[CRON_MIGRATED_PROPERTY] = 'v0.11.0';
      rewritten++;
      changed = true;
    } else {
      // Non-builtin handler → emit pending-host-work TODO.
      pendingEntries.push({
        type: 'cron-handler-needs-host-registration',
        handler,
        cron_schedule: schedule,
        manifest_path: path,
        current_cmd: `agentTurn ${handler}`,
        recommendation: `Add a handler registration for \`${handler}\` in your host worker bootstrap per docs/guides/plugin-handlers.md. Once registered, re-run \`pmbrain apply-migrations\` to auto-rewrite this entry.`,
        detected_at: new Date().toISOString(),
        status: 'pending',
      });
    }
  }

  if (changed && !opts.dryRun) {
    const beforeMtime = statSync(path).mtimeMs;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      writeFileSync(`${path}.bak.${stamp}`, content);
      const nowMtime = statSync(path).mtimeMs;
      if (nowMtime !== beforeMtime) {
        return { rewritten: 0, todos_emitted: 0, skipReason: 'file modified mid-rewrite — skipping' };
      }
      const output = Array.isArray(parsed) ? parsed : { ...(parsed as object), jobs: entries };
      writeFileSync(path, JSON.stringify(output, null, 2) + '\n');
    } catch (e) {
      return { rewritten: 0, todos_emitted: 0, skipReason: `write failed: ${e instanceof Error ? e.message : e}` };
    }
  }

  // Emit TODOs (deduped by handler + manifest_path).
  let todosEmitted = 0;
  if (pendingEntries.length > 0 && !opts.dryRun) {
    const existingTodos = loadPendingHostWork();
    const seen = new Set<string>(existingTodos.map(t => `${t.handler}::${t.manifest_path}`));
    for (const todo of pendingEntries) {
      const key = `${todo.handler}::${todo.manifest_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      appendPendingHostWork(todo);
      todosEmitted++;
    }
  }

  return { rewritten, todos_emitted: todosEmitted };
}

export function loadPendingHostWork(): PendingHostWorkEntry[] {
  const path = pendingHostWorkPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const out: PendingHostWorkEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as PendingHostWorkEntry); }
    catch { /* skip malformed line */ }
  }
  return out;
}

export function appendPendingHostWork(entry: PendingHostWorkEntry): void {
  mkdirSync(dirname(pendingHostWorkPath()), { recursive: true });
  appendFileSync(pendingHostWorkPath(), JSON.stringify(entry) + '\n');
}

async function phaseEHost(opts: OrchestratorOpts): Promise<{
  phase: OrchestratorPhaseResult;
  files_rewritten: number;
  pending_host_work: number;
}> {
  let filesTouched = 0;
  let todosEmitted = 0;
  const warnings: string[] = [];

  // AGENTS.md marker injection.
  for (const path of findAgentsMdFiles(opts)) {
    const { injected, skipReason } = injectAgentsMdMarker(path, opts);
    if (injected) filesTouched++;
    if (skipReason && skipReason !== 'already has marker' && skipReason !== 'dry-run') {
      warnings.push(`${path}: ${skipReason}`);
    }
  }

  // Cron manifest rewrites.
  for (const path of findCronManifests(opts)) {
    const { rewritten, todos_emitted, skipReason } = rewriteCronManifest(path, opts);
    filesTouched += rewritten;
    todosEmitted += todos_emitted;
    if (skipReason) warnings.push(`${path}: ${skipReason}`);
  }

  if (warnings.length > 0) {
    console.warn('[host-rewrite] warnings:');
    for (const w of warnings) console.warn(`  ${w}`);
  }

  return {
    phase: { name: 'host', status: 'complete', detail: `rewrote ${filesTouched} entries; ${todosEmitted} host-work TODOs emitted` },
    files_rewritten: filesTouched,
    pending_host_work: todosEmitted,
  };
}

// -----------------------------------------------------------------------
// Phase F — Autopilot install
// -----------------------------------------------------------------------

function phaseFInstall(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'install', status: 'skipped', detail: 'dry-run' };
  if (opts.noAutopilotInstall) return { name: 'install', status: 'skipped', detail: '--no-autopilot-install' };
  return { name: 'install', status: 'skipped', detail: 'host autopilot install is not run from migrations' };
}

// -----------------------------------------------------------------------
// Orchestrator
// -----------------------------------------------------------------------

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') {
    console.error(`Phase A (schema) failed: ${a.detail}. Aborting; re-run after fixing.`);
    return { version: '0.11.0', status: 'failed', phases };
  }

  const b = await phaseBSmoke(opts);
  phases.push(b);
  if (b.status === 'failed') {
    console.error(`Phase B (smoke) failed: ${b.detail}. Aborting; re-run after fixing.`);
    return { version: '0.11.0', status: 'failed', phases };
  }

  const { phase: c, mode } = await phaseCMode(opts);
  phases.push(c);

  const d = phaseDPrefs(mode, opts);
  phases.push(d);
  if (d.status === 'failed') {
    console.error(`Phase D (prefs) failed: ${d.detail}.`);
    return { version: '0.11.0', status: 'failed', phases };
  }

  const { phase: e, files_rewritten, pending_host_work } = await phaseEHost(opts);
  phases.push(e);

  const f = phaseFInstall(opts);
  phases.push(f);

  // Bug 3 — Phase G (record in completed.jsonl) moved to the runner. The
  // runner in apply-migrations.ts persists the result after orchestrator
  // returns, so we just decide the status here.
  const status: 'complete' | 'partial' = (pending_host_work > 0) ? 'partial' : 'complete';
  phases.push({ name: 'record', status: opts.dryRun ? 'skipped' : 'complete', detail: `status=${status} (ledger write in runner)` });

  // Post-run: print pending-host-work summary if anything needs host action.
  if (pending_host_work > 0) {
    console.log('');
    console.log(`${pending_host_work} host-specific item(s) need your agent's attention before the Minions migration is complete.`);
    console.log('');
    console.log('Next: run your host agent and have it read:');
    console.log(`  ${pendingHostWorkPath()}`);
    console.log(`  skills/migrations/v0.11.0.md`);
    console.log('');
    console.log('The skill walks the host through each item using PMBrain\'s plugin contract.');
    console.log('Re-run `pmbrain apply-migrations --yes` after each batch to auto-rewrite newly-');
    console.log('registerable crons and mark items done.');
  }

  return {
    version: '0.11.0',
    status,
    phases,
    files_rewritten,
    autopilot_installed: f.status === 'complete',
    pending_host_work,
  };
}

export const v0_11_0: Migration = {
  version: '0.11.0',
  featurePitch: {
    headline: 'GBrain Minions — durable background agents',
    description:
      'Turn any long-running agent task into a durable job that survives gateway ' +
      'restarts, streams progress, and can be paused, resumed, or steered mid-flight. ' +
      'Postgres-native, zero infra beyond your existing brain. Replaces flaky ' +
      'subagent spawns for multi-step work, parallel fan-out, and anything the ' +
      'user might ask about later.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  injectAgentsMdMarker,
  rewriteCronManifest,
  phaseEHost,
  findAgentsMdFiles,
  findCronManifests,
  BUILTIN_HANDLERS,
  AGENTS_MD_MARKER,
  loadPendingHostWork,
  pendingHostWorkPath,
};
