/**
 * PMBrain Operation: generate_report
 *
 * 生成项目报告。可以生成周报、月报或自定义报告。
 * 调用 report-gen phase 的逻辑。
 */

import type { BrainEngine } from './engine.ts';
import type { OperationContext } from './operations.ts';
import { runReportGen } from './cycle/report-gen.ts';

export interface GenerateReportOpts {
  /** 报告类型：weekly / monthly / custom */
  type?: 'weekly' | 'monthly' | 'custom';
  /** 自定义报告标题（type=custom 时使用）*/
  title?: string;
  /** 输出目录（默认 ~/.gbrain/reports/）*/
  outputDir?: string;
  /** 干运行模式 */
  dryRun?: boolean;
}

/**
 * 生成项目报告操作
 */
export async function generateReport(
  engine: BrainEngine,
  ctx: OperationContext,
  opts: GenerateReportOpts = {},
): Promise<{
  success: boolean;
  reportPath?: string;
  summary: string;
  details: Record<string, unknown>;
}> {
  const dryRun = !!opts.dryRun;
  const outputDir = opts.outputDir;

  try {
    // 调用 report-gen phase 的逻辑
    const result = await runReportGen(engine, {
      dryRun,
      outputDir,
    });

    if (result.status === 'fail') {
      return {
        success: false,
        summary: `报告生成失败: ${result.summary}`,
        details: result.details,
      };
    }

    const reportPath = result.details?.report_path as string | undefined;

    return {
      success: true,
      reportPath,
      summary: dryRun
        ? `将生成报告: ${result.summary}`
        : `报告已生成: ${result.summary}`,
      details: {
        report_path: reportPath,
        projects: result.details?.projects ?? 0,
        tasks_total: result.details?.tasks_total ?? 0,
        tasks_done: result.details?.tasks_done ?? 0,
        active_risks: result.details?.active_risks ?? 0,
        dryRun,
      },
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return {
      success: false,
      summary: `报告生成异常: ${err.message}`,
      details: { error: err.message },
    };
  }
}
