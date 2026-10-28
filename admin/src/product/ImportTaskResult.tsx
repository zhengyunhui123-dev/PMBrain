import type { ConsoleRun } from '../lib/shared';
import { importOutcome } from '../../../shared/import-outcome';

export function ImportTaskResult({ run }: { run: ConsoleRun }) {
  const summary = importOutcome(run.result);
  if (!summary) return null;
  const failures = (run.result as { failures?: Array<{ path: string; error: string }> }).failures ?? [];
  const resumed = (run.result as { resumedFiles?: number }).resumedFiles ?? 0;
  const ocrPending=Number((run.result as {ocrPending?:number}).ocrPending??0);
  return <section className="product-task-round" aria-label="逐份导入结果">
    <div>
      <h4>{summary.outcome === 'partial' ? '部分资料已导入' : summary.outcome === 'failed' ? '资料导入失败' : '资料导入结果'}</h4>
      <p>成功 {summary.imported} 份 · 跳过 {summary.unchanged} 份 · 失败 {summary.failed} 份{summary.partial > 0 ? ` · 部分导入 ${summary.partial} 份` : ''}</p>
      {resumed > 0 && <p>本次继续复用前次已完成的 {resumed} 份资料。</p>}
      {ocrPending>0&&<p>资料已保存，另有 {ocrPending} 项图片文字待补齐。可在任务中心查看后台识图进度。</p>}
      {summary.unchanged > 0 && <p>跳过的资料内容未变化或已存在，不计入失败。</p>}
      {(summary.failed > 0 || summary.partial > 0) && <p>已成功导入的资料保留。修复失败原因后，可继续未完成任务。</p>}
    </div>
    {failures.length > 0 && <details open={failures.length <= 5}><summary>查看未完成文件及原因（{failures.length} 份）</summary><ul>{failures.map((file, index) => <li key={`${file.path}-${index}`}><b>{file.path}</b><p>{file.error}</p></li>)}</ul></details>}
  </section>;
}
