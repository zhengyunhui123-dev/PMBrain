/**
 * Pure resolution for `pmbrain advisor --apply`.
 * The CLI confirms + executes; Admin maps the same ids onto existing jobs.
 */
import { isValidSourceId } from '../source-id.ts';
import type { AdvisorFinding, AdvisorReport } from './types.ts';

export type ApplyResolution =
  | { ok: true; argv: string[]; display: string }
  | { ok: false; error: string; runnable: string[] };

const SHELL_META = /[;&|`$<>(){}\n]/;
const ALLOWED_DISPATCH = /^(apply_migrations|embed_stale|sync_source:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/;

function argvIsSafe(argv: string[]): boolean {
  return argv[0] === 'pmbrain' && argv.every((token) => typeof token === 'string' && !SHELL_META.test(token));
}

function isRunnableFinding(finding: AdvisorFinding): boolean {
  const id = finding.fix.dispatch_id;
  const argv = finding.fix.command_argv;
  if (!id || !ALLOWED_DISPATCH.test(id) || !argv || argv.length === 0) return false;
  if (id.startsWith('sync_source:') && !isValidSourceId(id.slice('sync_source:'.length))) return false;
  return argvIsSafe(argv);
}

export function resolveApplyTarget(report: AdvisorReport, id: string): ApplyResolution {
  const runnable = report.findings
    .filter(isRunnableFinding)
    .map((finding) => finding.fix.dispatch_id!) as string[];
  const finding = report.findings.find((item) => item.fix.dispatch_id === id);
  if (!finding || !ALLOWED_DISPATCH.test(id)) {
    return { ok: false, error: `No runnable finding with apply id "${id}".`, runnable };
  }
  const argv = finding.fix.command_argv;
  if (!argv || argv.length === 0) {
    return { ok: false, error: `Finding "${id}" has no runnable command.`, runnable };
  }
  if (argv[0] !== 'pmbrain') {
    return { ok: false, error: 'Refusing to run: fix does not invoke pmbrain.', runnable };
  }
  if (!argv.every((token) => typeof token === 'string' && !SHELL_META.test(token))) {
    return { ok: false, error: 'Refusing to run: fix command contains unexpected characters.', runnable };
  }
  if (id.startsWith('sync_source:') && !isValidSourceId(id.slice('sync_source:'.length))) {
    return { ok: false, error: `No runnable finding with apply id "${id}".`, runnable };
  }
  return { ok: true, argv, display: argv.join(' ') };
}
