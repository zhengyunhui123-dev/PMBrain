import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import {configPath} from '../src/core/config';
import {reloadLiveGateway} from '../src/core/ai/reload-live-gateway';
import {resetGateway} from '../src/core/ai/gateway';
import {runMaintenanceVectorization} from '../src/product/tasks/maintenance-vectorization';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';

let root:string,engine:BrainEngine,server:ReturnType<typeof Bun.serve>;
const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const dimensions=database?1536:1024;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let inputs:string[]=[];
let onEmbedding:(()=>Promise<void>)|undefined;
const ready=async()=>({paused:false,schedule:{mode:'full' as const,reason:'电脑空闲',batchSize:32,delayMs:0}});

beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-maintenance-perf-'));mkdirSync(join(root,'.pmbrain'));
  for(const key of keys)delete process.env[key];
  process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const body=await request.json() as {input:string|string[]};
    const batch=Array.isArray(body.input)?body.input:[body.input];inputs.push(...batch);
    if(onEmbedding){const action=onEmbedding;onEmbedding=undefined;await action();}
    return Response.json({data:batch.map((_,index)=>({index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'audit-test',usage:{prompt_tokens:batch.length,total_tokens:batch.length}});
  }});
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',...(database?{database_url:database}:{database_path:join(root,'database')}),embedding_model:'custom-openai:audit-test',embedding_dimensions:dimensions,custom_openai_api_key:'isolated-only',provider_base_urls:{'custom-openai':server.url.origin+'/v1'},models:{default:'custom-openai:audit-test'},model_usage:{embedding_enabled:true,generative_enabled:true},desktop:{knowledge_directory:root}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  engine=(database?new PostgresEngine():new WorkerPgliteEngine()) as unknown as BrainEngine;
  await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();await reloadLiveGateway(engine);
},90000);

afterAll(async()=>{
  await engine?.disconnect();server?.stop(true);resetGateway();
  for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-maintenance-perf-'))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
},60000);

async function page(sourceId:string,slug:string,options:{deferred?:boolean;chunks?:number}={}){
  const count=options.chunks??1;
  await engine.putPage(slug,{type:'note',title:slug,compiled_truth:slug,frontmatter:options.deferred?{document_ocr_deferred:true}:{}},{sourceId});
  await engine.upsertChunks(slug,Array.from({length:count},(_,index)=>({chunk_index:index,chunk_text:`${slug} 内容 ${index}`,chunk_source:'compiled_truth' as const})),{sourceId});
}

test('等待识图的资料只需顺序检查，所有可处理资料仍完整向量化',async()=>{
  const sourceId='perf-queue';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'隔离测试']);
  for(let i=0;i<6;i++)await page(sourceId,`pending-${i}`,{deferred:true});
  for(let i=0;i<8;i++)await page(sourceId,`ready-${i}`,{chunks:4});
  const existing=Number(process.env.PMBRAIN_PERF_EXISTING_ROWS??0);
  if(existing>0){
    await engine.putPage('existing',{type:'note',title:'隔离存量',compiled_truth:'隔离存量'},{sourceId});
    const identity=await engine.getPageIdentity('existing',{sourceId});
    const zeroVector=`[${Array(dimensions).fill(0).join(',')}]`;
    await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source,embedding,model,embedded_at,embedded_text_hash)
      SELECT $1,n,repeat('隔离资料内容',60)||n::text,'compiled_truth',$2::vector,'custom-openai:audit-test',now(),md5(repeat('隔离资料内容',60)||n::text)
      FROM generate_series(0,$3-1) n`,[identity!.id,zeroVector,existing]);
  }
  await page('default','outside-source');
  let scans=0,ocrChecks=0,modelChecks=0,modelCheckMs=0,writes=0;
  const observed=new Proxy(engine,{get(target,key){
    if(key==='listStaleChunks')return async (...args:Parameters<BrainEngine['listStaleChunks']>)=>{scans++;return target.listStaleChunks(...args);};
    if(key==='executeRaw')return async (sql:string,params?:unknown[])=>{if(sql.includes("frontmatter->>'document_ocr_deferred'='true'")&&sql.includes('SELECT 1 FROM pages'))ocrChecks++;if(sql.includes('GROUP BY c.model')){modelChecks++;const started=performance.now();try{return await target.executeRaw(sql,params);}finally{modelCheckMs+=performance.now()-started;}}return target.executeRaw(sql,params);};
    if(key==='upsertChunks')return async (...args:Parameters<BrainEngine['upsertChunks']>)=>{writes++;return target.upsertChunks(...args);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  inputs=[];const started=performance.now();const result=await runMaintenanceVectorization(observed,sourceId,ready);const elapsed=Math.round(performance.now()-started);
  console.log(JSON.stringify({case:'maintenance-queue',existing,elapsedMs:elapsed,scans,ocrChecks,modelChecks,modelCheckMs:Math.round(modelCheckMs),writes,embedded:result.details.embedded}));
  expect(result.status).toBe('ok');expect(result.details).toMatchObject({embedded:32,pages_embedded_count:8,remainingChunks:0,ocrWaitingChunks:6});
  expect(inputs).toHaveLength(32);expect(new Set(inputs).size).toBe(32);expect(inputs.every(text=>text.startsWith('ready-'))).toBe(true);
  expect(await engine.countStaleChunks({sourceId})).toBe(6);expect(await engine.countStaleChunks({sourceId:'default'})).toBe(1);
  expect(scans).toBeLessThanOrEqual(24);expect(ocrChecks).toBeLessThanOrEqual(20);expect(modelChecks).toBe(1);
},120000);

test('暂停后恢复只补剩余资料，并重新检查处理期间新增的更早页面',async()=>{
  const sourceId='perf-resume';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'隔离继续测试']);
  await page(sourceId,'earlier',{deferred:true});await page(sourceId,'first');await page(sourceId,'second');
  let paused=false;inputs=[];
  onEmbedding=async()=>{paused=true;await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_ocr_deferred' WHERE source_id=$1 AND slug='earlier'",[sourceId]);};
  const first=await runMaintenanceVectorization(engine,sourceId,async()=>({...(await ready()),paused}));
  expect(first.details.vectorizationDeferred).toBe(true);expect(inputs).toEqual(['first 内容 0']);
  const second=await runMaintenanceVectorization(engine,sourceId,ready);
  expect(second.status).toBe('ok');expect(inputs.sort()).toEqual(['earlier 内容 0','first 内容 0','second 内容 0'].sort());expect(await engine.countStaleChunks({sourceId})).toBe(0);
},90000);

test('本轮处理期间较早页面变为待处理时，结束前仍会补上',async()=>{
  const sourceId='perf-rescan';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'隔离增量测试']);
  await page(sourceId,'earlier',{deferred:true});await page(sourceId,'later');
  inputs=[];onEmbedding=async()=>{await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_ocr_deferred' WHERE source_id=$1 AND slug='earlier'",[sourceId]);};
  const result=await runMaintenanceVectorization(engine,sourceId,ready);
  expect(result.status).toBe('ok');expect(inputs.sort()).toEqual(['earlier 内容 0','later 内容 0'].sort());expect(await engine.countStaleChunks({sourceId})).toBe(0);
},90000);

test('空闲时分批保存向量，半闲时保持更小写入并完整保留结果',async()=>{
  const sizes:number[]=[];
  const observed=new Proxy(engine,{get(target,key){
    if(key==='upsertChunks')return async (...args:Parameters<BrainEngine['upsertChunks']>)=>{sizes.push(args[1].length);return target.upsertChunks(...args);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  for(const [sourceId,mode,count] of [['perf-full','full',16],['perf-gentle','gentle',8]] as const){
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,`隔离批次测试 ${mode}`]);await page(sourceId,'page',{chunks:count});
    sizes.length=0;inputs=[];
    const started=performance.now();const result=await runMaintenanceVectorization(observed,sourceId,async()=>({paused:false,schedule:{mode,reason:'隔离测试',batchSize:32,delayMs:0}}));
    console.log(JSON.stringify({case:'maintenance-write',mode,elapsedMs:Math.round(performance.now()-started),writes:[...sizes]}));
    expect(result.status).toBe('ok');expect(result.details.embedded).toBe(count);expect(inputs).toHaveLength(count);
    expect(await engine.countStaleChunks({sourceId})).toBe(0);
    expect(sizes).toEqual(mode==='full'?Array(count/4).fill(4):Array(engine.kind==='pglite'?count:count/4).fill(engine.kind==='pglite'?1:4));
  }
},90000);

test('处理中资源变紧时从四条写入切回一条，已完成内容不丢失',async()=>{
  const sourceId='perf-pressure';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'隔离资源测试']);await page(sourceId,'pressure',{chunks:12});
  const sizes:number[]=[];const observed=new Proxy(engine,{get(target,key){
    if(key==='upsertChunks')return async (...args:Parameters<BrainEngine['upsertChunks']>)=>{sizes.push(args[1].length);return target.upsertChunks(...args);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  let mode:'full'|'gentle'='full';inputs=[];onEmbedding=async()=>{mode='gentle';};
  const result=await runMaintenanceVectorization(observed,sourceId,async()=>({paused:false,schedule:{mode,reason:'隔离测试',batchSize:4,delayMs:0}}));
  expect(result.status).toBe('ok');expect(result.details.embedded).toBe(12);expect(new Set(inputs).size).toBe(12);
  expect(sizes).toEqual(engine.kind==='pglite'?[4,1,1,1,1,1,1,1,1]:[4,4,4]);expect(await engine.countStaleChunks({sourceId})).toBe(0);
},90000);

test('停止后保留当前批次，继续时不重复识别已经保存的分块',async()=>{
  const sourceId='perf-batch-resume';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'隔离分批继续测试']);await page(sourceId,'resume',{chunks:12});
  let modelChecks=0;const observed=new Proxy(engine,{get(target,key){
    if(key==='executeRaw')return async (sql:string,params?:unknown[])=>{if(sql.includes('GROUP BY c.model'))modelChecks++;return target.executeRaw(sql,params);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  let paused=false;inputs=[];onEmbedding=async()=>{paused=true;};
  const state=async()=>({paused,schedule:{mode:'full' as const,reason:'隔离测试',batchSize:4,delayMs:0}});
  const first=await runMaintenanceVectorization(observed,sourceId,state);
  expect(first.details).toMatchObject({embedded:4,vectorizationDeferred:true,remainingChunks:8});expect(inputs).toHaveLength(4);
  const saved=await engine.executeRaw<{id:number;model:string;embedded_at:Date}>('SELECT c.id,c.model,c.embedded_at FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND c.embedding IS NOT NULL ORDER BY c.id',[sourceId]);
  paused=false;const second=await runMaintenanceVectorization(observed,sourceId,state);
  expect(second.status).toBe('ok');expect(second.details.embedded).toBe(8);expect(inputs).toHaveLength(12);expect(new Set(inputs).size).toBe(12);
  expect(modelChecks).toBe(2);
  expect(await engine.executeRaw('SELECT id,model,embedded_at FROM content_chunks WHERE id=ANY($1::bigint[]) ORDER BY id',[saved.map(row=>row.id)])).toEqual(saved);
},90000);

test('维护期间更换模型时重新检查已有向量，并在写入下一份资料前报错',async()=>{
  const sourceId='perf-model-change';await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$2)',[sourceId,'隔离模型切换测试']);
  await page(sourceId,'first');await page(sourceId,'second');inputs=[];
  const original=await Bun.file(configPath()).text();let changed=false;
  const observed=new Proxy(engine,{get(target,key){
    if(key==='upsertChunks')return async (...args:Parameters<BrainEngine['upsertChunks']>)=>{
      await target.upsertChunks(...args);
      if(!changed){changed=true;const config=JSON.parse(original);config.embedding_model='custom-openai:audit-test-other';writeFileSync(configPath(),JSON.stringify(config));await reloadLiveGateway(engine);}
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try{
    await expect(runMaintenanceVectorization(observed,sourceId,ready)).rejects.toThrow('检测到已有向量使用');
    expect(inputs).toEqual(['first 内容 0']);expect(await engine.countStaleChunks({sourceId})).toBe(1);
    const [first]=await engine.executeRaw<{model:string}>('SELECT c.model FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2',[sourceId,'first']);
    expect(first.model).toBe('custom-openai:audit-test');
  }finally{writeFileSync(configPath(),original);await reloadLiveGateway(engine);}
  const resumed=await runMaintenanceVectorization(engine,sourceId,ready);
  expect(resumed.status).toBe('ok');expect(inputs.sort()).toEqual(['first 内容 0','second 内容 0'].sort());
},90000);
