import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';
import { runAdvisor } from '../core/advisor/run.ts';
import { appendAdvisorRun } from '../core/advisor/history.ts';
import {
  buildAdvisorProductView,
  resolveAdminAdvisorAction,
  toProductSuggestion,
  type AdvisorProductView,
} from '../core/advisor/product.ts';
import type { AdvisorContext, AdvisorReport } from '../core/advisor/types.ts';
import { assertValidSourceId } from '../core/source-id.ts';
import { startActionRun, startRun, resolveCliEntry, type RunHooks } from './admin-console.ts';

export interface AdvisorAdminReport {
  report: AdvisorReport;
  product: AdvisorProductView;
}

export interface AdvisorAdminApplyResult {
  status: 'started' | 'restart_required' | 'navigate' | 'unsupported';
  runId?: string;
  kind?: string;
  page?: string;
  message?: string;
}

function buildContext(engine: BrainEngine, config: GBrainConfig): AdvisorContext {
  return {
    engine,
    config,
    version: VERSION,
    workspace: null,
    skillsDir: null,
    now: new Date(),
    remote: false,
  };
}

export async function getAdminAdvisorReport(
  engine: BrainEngine,
  config: GBrainConfig,
): Promise<AdvisorAdminReport> {
  const report = await runAdvisor(buildContext(engine, config));
  try {
    appendAdvisorRun(report);
  } catch {
    /* history is best-effort */
  }
  let score: number | null = null;
  try {
    const health = await engine.getHealth();
    score = Number.isFinite(health.brain_score) ? health.brain_score : null;
  } catch {
    score = null;
  }
  return { report, product: buildAdvisorProductView(report, score) };
}

export async function applyAdminAdvisorFinding(
  engine: BrainEngine,
  config: GBrainConfig,
  dispatchId: string,
  cwd: string,
  hooks?: RunHooks,
): Promise<AdvisorAdminApplyResult> {
  const { report } = await getAdminAdvisorReport(engine, config);
  const finding = report.findings.find((item) => item.fix.dispatch_id === dispatchId);
  if (!finding) {
    throw new Error(`没有可处理的建议：${dispatchId}`);
  }
  const suggestion = toProductSuggestion(finding);
  const action = resolveAdminAdvisorAction(suggestion);
  if (action.kind === 'restart_required') {
    return {
      status: 'restart_required',
      message: '请重启 PMBrain。数据库升级会在启动时自动完成，不要在正在运行的服务上直接改库。',
    };
  }
  if (action.kind === 'navigate') {
    return { status: 'navigate', page: action.page };
  }
  if (action.kind === 'unsupported') {
    return { status: 'unsupported', message: '这条建议需要先确认后再用命令处理，首页不能直接执行。' };
  }

  if (action.kind === 'embed_stale') {
    const run = await startActionRun('embed_stale', cwd, hooks);
    return { status: 'started', runId: run.id, kind: run.kind };
  }
  if (action.kind === 'sync_source') {
    assertValidSourceId(action.sourceId);
    const run = await startRun(
      'sync_source',
      [...resolveCliEntry(), 'sync', '--source', action.sourceId],
      cwd,
      hooks,
    );
    return { status: 'started', runId: run.id, kind: run.kind };
  }
  return { status: 'unsupported', message: '这条建议只提供查看入口，不会自动修改知识关系。' };
}
