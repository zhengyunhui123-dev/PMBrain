import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { ENTITY_CAPTURE_PENDING_PREFIX } from './entity-capture-request.ts';
import { chooseCaptureModel } from '../cycle/capture-entities.ts';

export function importedEntityCaptureIdempotencyKey(sourceId: string, value: string): string {
  return `imported-entities:${createHash('sha256').update(`${sourceId}\0${value}`).digest('hex')}`;
}

export async function enqueueImportedEntityCapture(engine: BrainEngine, modelReady: () => Promise<boolean> = async () => (await chooseCaptureModel(engine, {})).ok,timeoutMs=6*60*60_000): Promise<number[]> {
  const requests=await engine.executeRaw<{key:string;value:string;source_id:string}>(`SELECT c.key,c.value,s.id AS source_id FROM config c JOIN sources s ON c.key=$1||s.id WHERE NOT s.archived`,[ENTITY_CAPTURE_PENDING_PREFIX]);
  if (!requests.length || await engine.getConfig('dream.entity_capture.enabled')==='false' || !(await modelReady())) return [];
  const submitted:number[]=[];
  for(const request of requests) {
    let slugs:string[]|undefined;
    let ownerJobId:number|undefined;
    try{const parsed=JSON.parse(request.value);if(parsed.incremental!==true)continue;if(Array.isArray(parsed.slugs))slugs=parsed.slugs.filter((x:unknown):x is string=>typeof x==='string');if(Number.isSafeInteger(parsed.ownerJobId))ownerJobId=parsed.ownerJobId;}catch{}
    if(!slugs?.length)continue;
    const job=await engine.transaction(async tx=>{
      await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))',[`entity-capture:${request.source_id}`]);
      const [pending]=await tx.executeRaw<{value:string}>('SELECT value FROM config WHERE key=$1 FOR UPDATE',[request.key]);
      if(pending?.value!==request.value)return null;
      if(ownerJobId){
        const owner=await tx.executeRaw(`SELECT id FROM minion_jobs WHERE id=$1 AND status IN ('waiting','active','waiting-children','delayed','paused','cancelled')
          AND (data->'task'->>'type'='import' OR data->'task'->'input'->>'preset' IN ('quick','full')
          OR (data->>'fileSession'='true' AND data->'task'->'input'->>'phase' IS DISTINCT FROM 'sync'))`,[ownerJobId]);
        if(owner.length)return null;
      }
      const busy=await tx.executeRaw(`SELECT 1 FROM minion_jobs WHERE queue='pmbrain-product' AND name='pmbrain-product-task'
        AND ((data->'task'->'input'->>'phase'='capture_entities' AND data->'task'->'input'->>'sourceId'=$1)
          OR ((data->'task'->>'type'='import' OR data->'task'->'input'->>'preset' IN ('quick','full') OR (data->>'fileSession'='true' AND data->'task'->'input'->>'phase' IS DISTINCT FROM 'sync')) AND data->'task'->'input'->>'dryRun' IS DISTINCT FROM 'true'
            AND (data->'task'->'input'->>'allSources'='true' OR COALESCE(data->'task'->'input'->>'sourceId','default')=$1)))
        AND status IN ('waiting','active','waiting-children','delayed') LIMIT 1`,[request.source_id]);
      if(busy.length)return null;
      const queued=await new MinionQueue(tx).add('pmbrain-product-task',{
        kind:'dream_capture_entities',trigger:'scheduled',task:{type:'dream',input:{phase:'capture_entities',incrementalIngest:true,sourceId:request.source_id,slugs}},
      },{queue:'pmbrain-product',idempotency_key:importedEntityCaptureIdempotencyKey(request.source_id,request.value),max_attempts:1,timeout_ms:timeoutMs});
      await tx.executeRaw('DELETE FROM config WHERE key=$1 AND value=$2',[request.key,request.value]);
      return queued;
    });
    if(job)submitted.push(job.id);
  }
  return submitted;
}
