import type { ConsoleRun } from '../lib/shared';
import type { ImportRunRequest, ImportUploadOptions } from '../../../shared/contracts/import';
import {importOutcome} from '../../../shared/import-outcome';

export interface Material { id: string; name: string; path?: string; file?: File; runId?: string; taskSourceId?: string; autoEmbed?: boolean }
export function importNeedsEmbedding(items: Material[], autoEmbed: boolean) {
  return items.some(item => item.runId ? item.autoEmbed !== false : autoEmbed);
}
export interface ImportApi {
  startImportRun: (body: ImportRunRequest) => Promise<{ runId: string }>;
  startImportUploadRun: (file: File, body: ImportUploadOptions) => Promise<{ runId: string }>;
  run?: (id: string) => Promise<ConsoleRun>;
  retryRun?: (id: string) => Promise<{ runId: string }>;
}
export async function importMaterials(items: Material[], dependencies: {
  api: ImportApi;
  wait: (id: string, update: (run: ConsoleRun) => void) => Promise<ConsoleRun>;
  update: (run: ConsoleRun) => void;
  completed: (item: Material, run: ConsoleRun) => void;
  starting: (item: Material) => void;
  sourceId?: string;
  autoEmbed?: boolean;
  documentOcr?: boolean;
  accepted?: (item: Material, id: string) => void;
}) {
  for (const item of items) {
    dependencies.starting(item);
    const options = { autoEmbed: dependencies.autoEmbed ?? true, structuredDocuments: true, documentOcr: dependencies.documentOcr??true, workers: 1, sourceId: dependencies.sourceId };
    let accepted: { runId: string };
    if (item.runId) {
      if (item.taskSourceId !== dependencies.sourceId) throw new Error('此资料已有导入任务，不能更换数据源后继续；请先完成原任务，或移除后重新添加资料。');
      if (!dependencies.api.run) throw new Error('无法读取已受理的导入任务');
      const current = await dependencies.api.run(item.runId);
      const partial=importOutcome(current.result)?.outcome==='partial';
      if (current.status === 'completed'&&!partial) { dependencies.update(current); dependencies.completed(item, current); continue; }
      if (current.status === 'failed' || current.status === 'cancelled'||partial) {
        if (!dependencies.api.retryRun) throw new Error('无法继续已受理的导入任务');
        accepted = await dependencies.api.retryRun(item.runId);
      } else accepted = { runId: item.runId };
    } else accepted = item.file
      ? await dependencies.api.startImportUploadRun(item.file, options)
      : await dependencies.api.startImportRun({ ...options, path: item.path ?? '', includeOffice: true, includeImages: true });
    dependencies.accepted?.(item, accepted.runId);
    const run = await dependencies.wait(accepted.runId, dependencies.update);
    if (run.status !== 'completed'||importOutcome(run.result)?.outcome==='partial') throw new Error(run.error || run.stderr || (run.status === 'cancelled' ? '导入已停止' : `${item.name} 导入尚未全部完成，请查看任务中的未完成原因`));
    dependencies.completed(item, run);
  }
}
export function availableImportSources<T extends { archived?: boolean }>(sources: T[]): T[] {
  return sources.filter(source => !source.archived);
}
