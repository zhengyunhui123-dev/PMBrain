import { spawnSync } from 'child_process';
import { resolve as resolvePath } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { VERSION } from '../version.ts';
import { loadConfig } from '../core/config.ts';
import { autoDetectSkillsDir } from '../core/repo-root.ts';
import { runAdvisor } from '../core/advisor/run.ts';
import { renderAdvisorReport } from '../core/advisor/render.ts';
import { appendAdvisorRun, summarizeDeltas } from '../core/advisor/history.ts';
import { resolveApplyTarget } from '../core/advisor/apply.ts';
import type { AdvisorContext, AdvisorReport } from '../core/advisor/types.ts';
import { resolveCliEntry } from './natural-lang/commands.ts';

export interface AdvisorCliResult {
  exitCode: 0 | 1 | 2;
}

function buildContext(engine: BrainEngine): AdvisorContext {
  const det = autoDetectSkillsDir();
  const skillsDir = det.dir;
  const workspace = skillsDir ? resolvePath(skillsDir, '..') : null;
  return {
    engine,
    config: loadConfig() ?? ({} as AdvisorContext['config']),
    version: VERSION,
    workspace,
    skillsDir,
    now: new Date(),
    remote: false,
  };
}

function exitFor(report: AdvisorReport): 0 | 1 | 2 {
  if (report.worst === 'critical') return 2;
  if (report.worst === 'warn') return 1;
  return 0;
}

export async function runAdvisorCli(engine: BrainEngine, args: string[]): Promise<AdvisorCliResult> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'pmbrain advisor [--json] [--apply <finding-id>]\n\n' +
        '  (no flags)        Ranked, agent-readable action list for this brain.\n' +
        '  --json            Structured findings. Exit code: 0 clean / 1 warn / 2 critical.\n' +
        '  --apply <id>      Run ONE finding\'s fix (local-only, confirms first). Only findings\n' +
        '                    that report an apply id are runnable.\n\n' +
        'Read-only by default; never mutates without --apply + your confirmation.',
    );
    return { exitCode: 0 };
  }

  const json = args.includes('--json');
  const applyIdx = args.indexOf('--apply');
  const applyId = applyIdx >= 0 ? args[applyIdx + 1] : undefined;
  const report = await runAdvisor(buildContext(engine));

  if (applyId) {
    return applyFinding(report, applyId);
  }

  let deltaNote = '';
  try {
    const prior = appendAdvisorRun(report);
    deltaNote = summarizeDeltas(prior, report);
  } catch {
    /* history is best-effort */
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderAdvisorReport(report));
    if (deltaNote) process.stdout.write(deltaNote + '\n');
  }
  return { exitCode: exitFor(report) };
}

function applyFinding(report: AdvisorReport, id: string): AdvisorCliResult {
  const target = resolveApplyTarget(report, id);
  if (!target.ok) {
    console.error(
      target.error +
        (target.runnable.length ? ` Runnable now: ${target.runnable.join(', ')}.` : ' Nothing is runnable right now.'),
    );
    return { exitCode: 2 };
  }

  console.error(`About to run: ${target.display}`);
  if (!confirmTty('Proceed? [y/N]: ')) {
    console.error('Aborted. Nothing was run.');
    return { exitCode: 1 };
  }

  const rest = target.argv.slice(1);
  const [cmd, ...cmdArgs] = resolveCliEntry();
  const res = spawnSync(cmd!, [...cmdArgs, ...rest], { stdio: 'inherit', shell: false });
  return { exitCode: (res.status ?? 1) === 0 ? 0 : 2 };
}

function confirmTty(prompt: string): boolean {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(prompt);
  const buf = Buffer.alloc(8);
  try {
    const fs = require('fs') as typeof import('fs');
    const n = fs.readSync(0, buf, 0, 8, null);
    const ans = buf.toString('utf8', 0, n).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } catch {
    return false;
  }
}
