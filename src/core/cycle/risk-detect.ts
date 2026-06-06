/**
 * PMBrain Phase 2: risk_detect
 *
 * 扫描所有风险页面，识别高概率高影响的风险项。
 * 统计活跃风险、高优先级风险等指标。
 */

import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';
import { searchPages } from '../search.ts';

export interface RiskItem {
  title: string;
  probability: 'low' | 'medium' | 'high' | 'very_high';
  impact: 'low' | 'medium' | 'high' | 'very_high';
  mitigation?: string;
  status: string;
}

export async function runRiskDetect(
  engine: BrainEngine,
  opts: { dryRun?: boolean } = {},
): Promise<PhaseResult> {
  const start = Date.now();
  const dryRun = !!opts.dryRun;

  try {
    // 1. 搜索所有风险页面
    const risks = await searchPages(engine, { type: 'risk' });
    const meetings = await searchPages(engine, { type: 'meeting' });
    const decisions = await searchPages(engine, { type: 'decision' });

    // 2. 过滤活跃风险（未缓解、未关闭）
    const activeRisks = risks.filter(r => 
      r.status !== 'mitigated' && r.status !== 'closed'
    );

    // 3. 识别高优先级风险（高概率 AND 高影响）
    const highPriorityRisks = activeRisks.filter(r =>
      (r.probability === 'high' || r.probability === 'very_high') &&
      (r.impact === 'high' || r.impact === 'very_high')
    );

    // 4. 按项目分组风险统计
    const riskByProject = new Map<string, RiskItem[]>();
    for (const risk of activeRisks) {
      const project = risk.project || 'unassigned';
      const list = riskByProject.get(project) || [];
      list.push({
        title: risk.title,
        probability: risk.probability,
        impact: risk.impact,
        mitigation: risk.mitigation,
        status: risk.status,
      });
      riskByProject.set(project, list);
    }

    // 5. 汇总结果
    const riskSummary = Array.from(riskByProject.entries()).map(([project, items]) => ({
      project,
      total_risks: items.length,
      high_probability: items.filter(r => r.probability === 'high' || r.probability === 'very_high').length,
      high_impact: items.filter(r => r.impact === 'high' || r.impact === 'very_high').length,
      needs_attention: items.filter(r => 
        (r.probability === 'high' || r.probability === 'very_high') &&
        (r.impact === 'high' || r.impact === 'very_high')
      ).length,
    }));

    return {
      phase: 'risk_detect' as CyclePhase,
      status: highPriorityRisks.length > 0 ? 'warn' : 'ok',
      duration_ms: Date.now() - start,
      summary: dryRun
        ? `Would analyze ${risks.length} risk(s) (dry-run)`
        : `${activeRisks.length} active risk(s), ${highPriorityRisks.length} high-priority risk(s), ${meetings.length} recent meeting(s)`,
      details: {
        total_risks: risks.length,
        active_risks: activeRisks.length,
        high_priority_risks: highPriorityRisks.length,
        recent_meetings: meetings.length,
        recent_decisions: decisions.length,
        risks_by_project: riskSummary,
        high_priority_list: highPriorityRisks.map(r => ({
          title: r.title,
          probability: r.probability,
          impact: r.impact,
          mitigation: r.mitigation || 'None',
        })),
        dryRun,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return {
      phase: 'risk_detect' as CyclePhase,
      status: 'fail',
      duration_ms: Date.now() - start,
      summary: `risk_detect phase failed: ${err.message}`,
      details: { error: err.message },
      error: {
        class: 'InternalError',
        code: 'RISK_DETECT_ERROR',
        message: err.message,
      },
    };
  }
}
