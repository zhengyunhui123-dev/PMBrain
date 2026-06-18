/**
 * PMBrain Phase 1: project_health
 *
 * 扫描所有项目页面，评估项目健康度。
 * 检查任务完成率、阻塞任务、超期任务等指标。
 */

import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';
import { searchPages } from '../search.ts';

export interface ProjectHealthResult {
  project: string;
  health: 'healthy' | 'at_risk' | 'critical';
  taskStats: {
    total: number;
    done: number;
    blocked: number;
    overdue: number;
  };
  progress: number;  // 0-100
}

export async function runProjectHealth(
  engine: BrainEngine,
  opts: { dryRun?: boolean } = {},
): Promise<PhaseResult> {
  const start = Date.now();
  const dryRun = !!opts.dryRun;

  try {
    // 1. 搜索所有项目页面
    const projects = await searchPages(engine, { type: 'project' });
    const results: ProjectHealthResult[] = [];

    // 2. 对每个项目评估健康度
    for (const project of projects) {
      const projectTitle = String(project.title);
      const tasks = await searchPages(engine, { type: 'task', project: projectTitle });
      const total = tasks.length;
      const done = tasks.filter(t => t.status === 'done').length;
      const blocked = tasks.filter(t => t.status === 'blocked').length;
      const overdue = tasks.filter(t => {
        if (!t.deadline) return false;
        return new Date(String(t.deadline)) < new Date() && t.status !== 'done';
      }).length;

      // 判断健康度
      let health: ProjectHealthResult['health'] = 'healthy';
      if (blocked > 0 || overdue > 2) {
        health = 'at_risk';
      }
      if (blocked > total * 0.3 || overdue > total * 0.5) {
        health = 'critical';
      }

      results.push({
        project: projectTitle,
        health,
        taskStats: { total, done, blocked, overdue },
        progress: total > 0 ? Math.round((done / total) * 100) : 0,
      });
    }

    // 3. 汇总结果
    const healthyCount = results.filter(r => r.health === 'healthy').length;
    const atRiskCount = results.filter(r => r.health === 'at_risk').length;
    const criticalCount = results.filter(r => r.health === 'critical').length;

    return {
      phase: 'project_health' as CyclePhase,
      status: criticalCount > 0 ? 'warn' : 'ok',
      duration_ms: Date.now() - start,
      summary: dryRun
        ? `Would check ${projects.length} project(s) (dry-run)`
        : `${projects.length} project(s): ${healthyCount} healthy, ${atRiskCount} at risk, ${criticalCount} critical`,
      details: {
        projects_checked: projects.length,
        healthy: healthyCount,
        at_risk: atRiskCount,
        critical: criticalCount,
        results: results.map(r => ({
          project: r.project,
          health: r.health,
          progress: r.progress,
          blocked_tasks: r.taskStats.blocked,
          overdue_tasks: r.taskStats.overdue,
        })),
        dryRun,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return {
      phase: 'project_health' as CyclePhase,
      status: 'fail',
      duration_ms: Date.now() - start,
      summary: `project_health phase failed: ${err.message}`,
      details: { error: err.message },
      error: {
        class: 'InternalError',
        code: 'PROJECT_HEALTH_ERROR',
        message: err.message,
      },
    };
  }
}
