import {expect} from 'bun:test';
import type {BrainEngine} from '../../src/core/engine.ts';
import type {OperationContext} from '../../src/core/operations.ts';
import {operationsByName} from '../../src/core/operations.ts';
import {configureGateway,resetGateway} from '../../src/core/ai/gateway.ts';
import {getBrainHotMemoryMeta,__resetHotMemoryCacheForTests} from '../../src/core/facts/meta-hook.ts';

export async function verifyWritebackTtl(engine: BrainEngine) {
  configureGateway({env:{}});
  const ctx={engine,config:{engine:"pglite"},remote:false,sourceId:'default',dryRun:false,logger:{info(){},warn(){},error(){}}} as OperationContext;
  try {
    const remembered=await operationsByName.remember!.handler(ctx,{fact:'本周出差住在上海，周末返回成都。',provenance:'writeback TTL test',ttl:'3d',visibility:'world'}) as {id:string};
    const records=await engine.listFactsSince('default',new Date(0),{activeOnly:false});
    const record=records.find(f=>f.fact==='本周出差住在上海，周末返回成都。')!;
    expect(record.valid_until).not.toBeNull();
    const before=await engine.executeRaw('SELECT id,fact,embedding::text AS embedding FROM facts WHERE id=$1',[record.id]);
    await engine.executeRaw("UPDATE facts SET valid_until=now()-interval '1 second' WHERE id=$1",[record.id]);
    const active=await operationsByName.recall!.handler(ctx,{limit:100}) as {facts:Array<{fact:string}>};
    expect(active.facts.some(f=>f.fact===record.fact)).toBe(false);
    const history=await operationsByName.recall!.handler(ctx,{include_expired:true,limit:100}) as {facts:Array<{fact:string}>};
    expect(history.facts.some(f=>f.fact===record.fact)).toBe(true);
    expect(await engine.executeRaw('SELECT id,fact,embedding::text AS embedding FROM facts WHERE id=$1',[record.id])).toEqual(before);
    __resetHotMemoryCacheForTests();
    const meta=await getBrainHotMemoryMeta('get_stats',ctx) as any;
    expect(meta?.brain_hot_memory?.facts?.some((f:any)=>f.fact===record.fact)??false).toBe(false);
  } finally {resetGateway();__resetHotMemoryCacheForTests();}
}
