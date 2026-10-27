import {test,expect} from 'bun:test';
import {runMaintenanceVectorization,mergeEmbeddingWindow} from '../src/product/tasks/maintenance-vectorization';
import type {BrainEngine} from '../src/core/engine';
import type {PhaseResult} from '../src/core/cycle';

test('维护向量暂停时只保存等待检查点，不进入模型调用',async()=>{
  const engine={listStaleChunks:async()=>[{source_id:'first',slug:'same'}],countStaleChunks:async()=>2} as unknown as BrainEngine;
  const phase=await runMaintenanceVectorization(engine,'first',async()=>({paused:true,schedule:{mode:'full',reason:'电脑空闲',batchSize:32,delayMs:0}}));
  expect(phase.status).toBe('warn');expect(phase.details).toMatchObject({vectorizationDeferred:true,embedded:0,remainingChunks:2});
});

test('电脑忙时仍保留明确 Source 范围',async()=>{
  const scopes:unknown[]=[];
  const engine={listStaleChunks:async(options:any)=>{scopes.push(options.sourceId);return [{source_id:'chosen',slug:'a'}];},countStaleChunks:async(options:any)=>{scopes.push(options.sourceId);return 1;}} as unknown as BrainEngine;
  const phase=await runMaintenanceVectorization(engine,'chosen',async()=>({paused:false,schedule:{mode:'waiting',reason:'等待电脑空闲',batchSize:0,delayMs:5000}}));
  expect(scopes).toEqual(['chosen','chosen']);expect(phase.details.waitReason).toBe('等待电脑空闲');
});

test('读取暂停状态失败时保留原始错误',async()=>{
  const engine={listStaleChunks:async()=>[{source_id:'first',slug:'a'}]} as unknown as BrainEngine;
  await expect(runMaintenanceVectorization(engine,'first',async()=>{throw new Error('native state error');})).rejects.toThrow('native state error');
});

test('没有缺失向量时维护正常完成，不等待暂停解除',async()=>{
  let calls=0;const engine={listStaleChunks:async()=>[],countStaleChunks:async()=>0} as unknown as BrainEngine;
  const phase=await runMaintenanceVectorization(engine,'first',async()=>{calls++;throw new Error('unexpected state read');});
  expect(calls).toBe(0);expect(phase.details.embedded).toBe(0);expect(phase.status).toBe('ok');
});

test('多次等待的向量成果累计，剩余量取本批结果',()=>{
  const phase=(embedded:number,remainingChunks:number):PhaseResult=>({phase:'embed',status:'warn',summary:'等待',duration_ms:2,details:{embedded,remainingChunks,committedBatches:1,pages_embedded_count:1}});
  const merged=mergeEmbeddingWindow(phase(4,8),phase(3,5));
  expect(merged.details).toMatchObject({embedded:7,remainingChunks:5,committedBatches:2,pages_embedded_count:2});expect(merged.duration_ms).toBe(4);expect(merged.summary).toBe('已保存 7 个向量');
});
