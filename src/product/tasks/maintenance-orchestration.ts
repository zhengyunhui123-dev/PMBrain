import type { BrainEngine } from '../../core/engine.ts';
import { ENTITY_CAPTURE_PENDING_PREFIX } from '../../core/pmbrain-adapters/entity-capture-request.ts';
import type { ProductTask, MaintenanceCheckpoint } from './types.ts';
import { usesSyncFileQueue } from '../../../shared/task-progress.ts';

export function maintenanceFailure(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const report = result as { status?: string; reason?: string; phases?: Array<{ status?: string; error?: { message?: string }; details?: Record<string,unknown> & { stop_reason?: string } }> };
  if (report.status === 'skipped') return report.reason === 'cycle_already_running' ? '未执行：其他整理任务占用数据库，请排队后继续。' : `未执行：${report.reason ?? '整理被跳过'}`;
  const errorKeys=['ner_error','by_mention_error','relation_backfill_error'];
  const failed = report.phases?.find(phase => phase.status === 'fail' || errorKeys.some(key=>!!phase.details?.[key]) || (phase.error?.message && !['tokens', 'cost'].includes(phase.details?.stop_reason ?? '')) || ['failure', 'ingest_validation', 'relation_failure', 'model_unavailable'].includes(phase.details?.stop_reason ?? ''));
  if(failed){
    const detailError=errorKeys.map(key=>failed.details?.[key]).find((value):value is string=>typeof value==='string');
    return failed.error?.message??detailError??'整理验收失败，请查看任务详情。';
  }
  return report.status==='failed'?'整理执行失败，请查看任务详情。':null;
}

export async function claimMaintenanceCapture(engine: BrainEngine, id: number, token: string, sourceId: string, allowedSlugs?:string[]): Promise<string[] | undefined> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [`entity-capture:${sourceId}`]);
    const [owner] = await tx.executeRaw<{ data: { task: ProductTask } }>(`SELECT j.data FROM minion_jobs j JOIN sources s ON s.id=$3
      WHERE j.id=$1 AND j.status='active' AND j.lock_token=$2 AND NOT s.archived FOR UPDATE OF j`, [id, token, sourceId]);
    const task = owner?.data.task;
    if (!task || (task.type !== 'dream' && task.type !== 'import') || (task.type==='dream' && ((!usesSyncFileQueue(task.input)&&task.input.preset!=='meeting'&&task.input.phase!=='capture_entities') || task.input.phase==='sync')) || (!(task.type==='dream'&&task.input.allSources) && (task.input.sourceId??'default')!==sourceId)) throw new Error('实体识别不属于当前整理任务或Source已改变');
    const checkpoint: MaintenanceCheckpoint = (task.type==='import'?task.input.knowledgeCheckpoint:task.input.checkpoint) ?? { phases: {}, reports: {} };
    const key = ENTITY_CAPTURE_PENDING_PREFIX + sourceId;
    const [pending] = await tx.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1 FOR UPDATE', [key]);
    const request = pending ? JSON.parse(pending.value) as { slugs?: string[];owners?:Record<string,number> } : undefined;
    const claimed=(request?.slugs??[]).filter(slug=>!allowedSlugs || allowedSlugs.includes(slug) || task.type==='import'&&request?.owners?.[slug]===id);
    const slugs = [...new Set([...(checkpoint.captureRequests?.[sourceId] ?? []), ...claimed])];
    if (!slugs.length) return undefined;
    checkpoint.captureRequests = { ...checkpoint.captureRequests, [sourceId]: slugs };
    const checkpointPath=task.type==='import'?'{task,input,knowledgeCheckpoint}':'{task,input,checkpoint}';
    await tx.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,$4::text[],$3::jsonb),updated_at=now() WHERE id=$1 AND lock_token=$2`, [id, token, checkpoint,checkpointPath]);
    if (pending) {
      const remaining=(request?.slugs??[]).filter(slug=>!claimed.includes(slug));
      if(remaining.length)await tx.setConfig(key,JSON.stringify({...request,slugs:remaining,owners:Object.fromEntries(Object.entries(request?.owners??{}).filter(([slug])=>remaining.includes(slug)))}));
      else await tx.executeRaw('DELETE FROM config WHERE key=$1 AND value=$2', [key, pending.value]);
    }
    return slugs;
  });
}
