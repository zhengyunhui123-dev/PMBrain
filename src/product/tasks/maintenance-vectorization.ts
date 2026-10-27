import type {BrainEngine} from '../../core/engine.ts';
import type {PhaseResult} from '../../core/cycle.ts';
import {runEmbedCore} from '../../commands/embed.ts';
import type {VectorizationSchedule} from '../../../shared/background-vectorization';
import {setTimeout as waitForBatch} from 'node:timers/promises';

export interface MaintenanceVectorizationState {paused:boolean;schedule:VectorizationSchedule}
export class MaintenanceVectorizationDeferred extends Error {}

export function mergeEmbeddingWindow(previous:PhaseResult|undefined,current:PhaseResult):PhaseResult{
  if(!previous)return current;
  const details={...current.details};
  for(const key of ['embedded','pages_embedded_count','committedBatches'])details[key]=Number(previous.details[key]??0)+Number(details[key]??0);
  return {...current,summary:current.details.vectorizationDeferred?current.summary:`已保存 ${details.embedded} 个向量`,duration_ms:previous.duration_ms+current.duration_ms,details};
}

export async function runMaintenanceVectorization(engine:BrainEngine,sourceId:string|undefined,state:()=>Promise<MaintenanceVectorizationState>,options:{pageLimit?:number;signal?:AbortSignal;onProgress?:(schedule:VectorizationSchedule,slug:string,done:number,total:number)=>void}={}):Promise<PhaseResult>{
  const started=Date.now();
  const details:Record<string,unknown>={embedded:0,pages_embedded_count:0,committedBatches:0};
  let schedule:VectorizationSchedule|undefined,lastBatchAt=0;
  const paused=async()=>{
    options.signal?.throwIfAborted();
    const current=await state();schedule=current.schedule;
    return current.paused||schedule.mode==='waiting';
  };
  const finish=async(deferred=false):Promise<PhaseResult>=>{
    details.remainingChunks=await engine.countStaleChunks(sourceId?{sourceId}:undefined);
    if(deferred){details.vectorizationDeferred=true;details.waitReason=schedule?.reason;}
    return {phase:'embed',status:deferred||Number(details.remainingChunks)>0?'warn':'ok',duration_ms:Date.now()-started,summary:deferred?'向量化等待继续，已完成的部分已保存':`已保存 ${details.embedded} 个向量`,details};
  };
  for(;;){
    options.signal?.throwIfAborted();
    const [next]=await engine.listStaleChunks({batchSize:1,...(sourceId?{sourceId}:{})});
    if(!next)return finish();
    if(options.pageLimit&&Number(details.pages_embedded_count)>=options.pageLimit)return finish();
    if(await paused()||Date.now()-started>=60000)return finish(true);
    const result=await runEmbedCore(engine,{
      slugs:[next.slug],sourceId:next.source_id,batchSize:32,
      getBatchSize:()=>schedule?.batchSize||4,writeBatchSize:engine.kind==='pglite'?1:4,
      quiet:true,signal:options.signal,
      pauseCheck:async()=>{
        const delay=(schedule?.delayMs??0)-(Date.now()-lastBatchAt);
        if(delay>0)await waitForBatch(delay,undefined,{signal:options.signal});
        return await paused()||Date.now()-started>=60000;
      },
      onProgress:(done,total)=>{lastBatchAt=Date.now();options.onProgress?.(schedule!,next.slug,done,total);},
    });
    details.embedded=Number(details.embedded)+result.embedded;
    details.committedBatches=Number(details.committedBatches)+result.committedBatches;
    options.signal?.throwIfAborted();
    if(result.error||result.failedPages||result.status==='failed')throw new Error(result.error||'知识向量化未完成');
    if(result.incomplete)return finish(true);
    if(result.embedded===0)throw new Error(`资料 ${next.slug} 的待向量化分块未能推进`);
    details.pages_embedded_count=Number(details.pages_embedded_count)+1;
  }
}
