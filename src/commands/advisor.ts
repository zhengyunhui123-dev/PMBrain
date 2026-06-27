import type { BrainEngine } from '../core/engine.ts';
import { VERSION } from '../version.ts';
import { loadConfig } from '../core/config.ts';
import { runAdvisor } from '../core/advisor/run.ts';
import { renderAdvisorReport } from '../core/advisor/render.ts';
import type { AdvisorContext, AdvisorReport } from '../core/advisor/types.ts';

export interface AdvisorCliResult {
  exitCode: 0 | 1 | 2;
}

function buildContext(engine: BrainEngine): AdvisorContext {
  return {
    engine,
    config: loadConfig() ?? ({} as AdvisorContext['config']),
    version: VERSION,
    now: new Date(),
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
      'pmbrain advisor [--json]\n\n' +
        '  (no flags)        Ranked, agent-readable action list for this brain.\n' +
        '  --json            Structured findings. Exit code: 0 clean / 1 warn / 2 critical.\n\n' +
        'Read-only; never mutates.',
    );
    return { exitCode: 0 };
  }

  const report = await runAdvisor(buildContext(engine));
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderAdvisorReport(report));
  }
  return { exitCode: exitFor(report) };
}
