import {test,expect} from 'bun:test';
import {runMaintenanceVectorization,mergeEmbeddingWindow} from '../src/product/tasks/maintenance-vectorization';
import type {BrainEngine} from '../src/core/engine';
import type {PhaseResult} from '../src/core/cycle';

type StaleChunk={page_id:number;source_id:string;slug:string};
function makeEngine(options:{stale?:StaleChunk[];staleCount?:number;deferredPageIds?:number[];deferredCount?:number;scopes?:unknown[]}={}):BrainEngine{
  const rows=options.stale??[];
  return {
    kind:'postgres',
    listStaleChunks:async(query:any)=>{
      options.scopes?.push(query.sourceId);
      return rows.filter(row=>row.page_id>query.afterPageId&&(!query.sourceId||row.source_id===query.sourceId)).slice(0,query.batchSize);
    },
    countStaleChunks:async(query:any)=>{options.scopes?.push(query?.sourceId);return options.staleCount??rows.length;},
    executeRaw:async(sql:string,params?:unknown[])=>{
      if(sql.includes('SELECT 1 FROM pages WHERE id=$1'))return (options.deferredPageIds??[]).includes(Number(params?.[0]))?[{}]:[];
      if(sql.includes('SELECT count(*)::int count FROM content_chunks'))return [{count:options.deferredCount??0}];
      throw new Error(`Unexpected SQL in maintenance vectorization test: ${sql}`);
    },
  } as unknown as BrainEngine;
}

test('维护向量暂停时只保存等待检查点，不进入模型调用',async()=>{
  const engine=makeEngine({stale:[{page_id:1,source_id:'first',slug:'same'}],staleCount:2});
  const phase=await runMaintenanceVectorization(engine,'first',async()=>({paused:true,schedule:{mode:'full',reason:'电脑空闲',batchSize:32,delayMs:0}}));
  expect(phase.status).toBe('warn');expect(phase.details).toMatchObject({vectorizationDeferred:true,embedded:0,remainingChunks:2});
});

test('电脑忙时仍保留明确 Source 范围',async()=>{
  const scopes:unknown[]=[];
  const engine=makeEngine({stale:[{page_id:1,source_id:'chosen',slug:'a'}],staleCount:1,scopes});
  const phase=await runMaintenanceVectorization(engine,'chosen',async()=>({paused:false,schedule:{mode:'waiting',reason:'等待电脑空闲',batchSize:0,delayMs:5000}}));
  expect(scopes).toEqual(['chosen','chosen']);expect(phase.details.waitReason).toBe('等待电脑空闲');
});

test('读取暂停状态失败时保留原始错误',async()=>{
  const engine=makeEngine({stale:[{page_id:1,source_id:'first',slug:'a'}]});
  await expect(runMaintenanceVectorization(engine,'first',async()=>{throw new Error('native state error');})).rejects.toThrow('native state error');
});

test('没有缺失向量时维护正常完成，不等待暂停解除',async()=>{
  let calls=0;const engine=makeEngine();
  const phase=await runMaintenanceVectorization(engine,'first',async()=>{calls++;throw new Error('unexpected state read');});
  expect(calls).toBe(0);expect(phase.details.embedded).toBe(0);expect(phase.status).toBe('ok');
});

test('OCR 延后页跳过向量化并计入当前 Source 的等待数量',async()=>{
  const scopes:unknown[]=[];
  const engine=makeEngine({
    stale:[
      {page_id:1,source_id:'chosen',slug:'ocr-pending'},
      {page_id:2,source_id:'chosen',slug:'ready'},
    ],
    staleCount:2,
    deferredPageIds:[1],
    deferredCount:1,
    scopes,
  });
  const phase=await runMaintenanceVectorization(engine,'chosen',async()=>({paused:true,schedule:{mode:'full',reason:'电脑空闲',batchSize:32,delayMs:0}}));
  expect(scopes).toEqual(['chosen','chosen','chosen']);
  expect(phase.details).toMatchObject({vectorizationDeferred:true,remainingChunks:1,ocrWaitingChunks:1});
});

test('多次等待的向量成果累计，剩余量取本批结果',()=>{
  const phase=(embedded:number,remainingChunks:number):PhaseResult=>({phase:'embed',status:'warn',summary:'等待',duration_ms:2,details:{embedded,remainingChunks,committedBatches:1,pages_embedded_count:1}});
  const merged=mergeEmbeddingWindow(phase(4,8),phase(3,5));
  expect(merged.details).toMatchObject({embedded:7,remainingChunks:5,committedBatches:2,pages_embedded_count:2});expect(merged.duration_ms).toBe(4);expect(merged.summary).toBe('已保存 7 个向量');
});
