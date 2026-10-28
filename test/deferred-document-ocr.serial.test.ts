import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {createCanvas} from '@napi-rs/canvas';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';
import type {BrainEngine} from '../src/core/engine';
import {ProductTaskRuntime} from '../src/product/tasks/runtime';
import {importOfficeFile} from '../src/core/office-import';
import {importImageFile} from '../src/core/import-file';
import {configPath} from '../src/core/config';
import {reloadLiveGateway} from '../src/core/ai/reload-live-gateway';
import {resetGateway} from '../src/core/ai/gateway';
import {readContentChunksEmbeddingDim} from '../src/core/embedding-dim-check';
import {selectEntityCaptureCandidates} from '../src/core/cycle/capture-entities';
let root:string,dir:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>,cpu=0.95,calls=0,failAt=-1;
let dimensions=1280,embeddingCalls=0,captureCalls=0,holdOcr:Promise<void>|undefined;const events:string[]=[],captureSources:string[]=[];
const database=process.env.PMBRAIN_DOCUMENT_OCR_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-deferred-ocr-'));dir=join(root,'materials');mkdirSync(dir);mkdirSync(join(root,'.pmbrain'));for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json() as any;if(new URL(request.url).pathname.endsWith('/embeddings')){embeddingCalls++;events.push('embed');const inputs=Array.isArray(body.input)?body.input:[body.input];return Response.json({data:inputs.map((_:unknown,index:number)=>({index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'deferred-embed',usage:{prompt_tokens:inputs.length,total_tokens:inputs.length}});}if(!JSON.stringify(body).includes('data:image/')){captureCalls++;captureSources.push(JSON.stringify(body));events.push('capture');if(JSON.stringify(body).includes('chain.docx'))events.push('chain_capture');return Response.json({choices:[{message:{role:'assistant',content:JSON.stringify({entities:[],relations:[],no_entities:true})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}calls++;events.push('ocr');if(holdOcr)await holdOcr;if(calls===failAt)return Response.json({error:{message:'fixture OCR rejected'}},{status:400});return Response.json({choices:[{message:{role:'assistant',content:'DeferredEvidence '+calls},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}});
  if(database)assertSafeE2eDatabaseUrl(database);
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',...(database?{database_url:database}:{database_path:join(root,'database')}),custom_openai_api_key:'isolated-only',models:{default:'custom-openai:isolated-office-ocr'},provider_base_urls:{'custom-openai':server.url.origin+'/v1'},model_usage:{generative_enabled:true,embedding_enabled:false}}));
  engine=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();const [existing]=await engine.executeRaw<{n:number}>('SELECT count(*)::int n FROM pages');if(existing.n)throw Error('后台识图回归需要全新的隔离测试库，拒绝覆盖已有资料');await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[dir]);await engine.setConfig('dream.entity_capture.enabled','false');await engine.setConfig('dream.knowledge.enabled','false');await reloadLiveGateway(engine);await start();
},90000);
afterAll(async()=>{await runtime?.close();await engine?.disconnect();server?.stop(true);resetGateway();for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-deferred-ocr-'))throw Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}},60000);
async function word(name:string,text='Native text stays available'){
  const path=join(dir,name+'.docx'),zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for(let index=0;index<3;index++){const canvas=createCanvas(40,40),ctx=canvas.getContext('2d');ctx.fillStyle='#'+createHash('sha256').update(name+index).digest('hex').slice(0,6);ctx.fillRect(0,0,40,40);zip.file('word/media/image'+index+'.png',canvas.toBuffer('image/png'));}writeFileSync(path,await zip.generateAsync({type:'nodebuffer'}));return path;
}
async function start(){runtime=new ProductTaskRuntime(engine,{background:{sample:()=>({cpuBusyRatio:cpu,bytes:1024**3,availableBytes:12*1024**3,totalBytes:16*1024**3,systemIdleSeconds:100})}});await runtime.start();}
async function vectorConfiguration(){
  dimensions=(await readContentChunksEmbeddingDim(engine)).dims!;const config=JSON.parse(readFileSync(configPath(),'utf8'));config.embedding_model='custom-openai:deferred-embed';config.embedding_dimensions=dimensions;config.model_usage.embedding_enabled=true;writeFileSync(configPath(),JSON.stringify(config));await reloadLiveGateway(engine);
  await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:isolated-office-ocr':{input:1,output:1},'custom-openai:deferred-embed':{input:1,output:0}}));
}
async function finish(id:number){const until=Date.now()+60000;let last:any;while(Date.now()<until){last=await runtime.getRun('task-'+id);if(last&&!['running','queued'].includes(last.status))return last;await Bun.sleep(60);}throw Error('OCR task timeout '+JSON.stringify({run:last,rows:await engine.executeRaw('SELECT id,name,queue,status,attempts_started,progress,error_text FROM minion_jobs')}));}
const options={sourceId:'default',noEmbed:true,documentOcr:true,deferDocumentOcr:true};

test('先保存可提取正文、零识图请求，重复导入只保留一个后台任务',async()=>{
  const path=await word('first'),before=calls,result=await importOfficeFile(engine,path,'first.docx',options as any);expect(result.status).toBe('imported');expect(calls).toBe(before);expect((result as any).ocrPending).toBe(3);expect((result as any).ocrTaskId).toBeGreaterThan(0);
  const page=await engine.getPage(result.slug),chunks=await engine.executeRaw('SELECT id,chunk_text FROM content_chunks WHERE page_id=$1 ORDER BY id',[page!.id]);expect(page!.compiled_truth).toContain('Native text stays available');
  const again=await importOfficeFile(engine,path,'first.docx',options as any);expect((again as any).ocrTaskId).toBe((result as any).ocrTaskId);expect(calls).toBe(before);
  await Bun.sleep(400);expect(calls).toBe(before);cpu=0.1;const done=await finish((result as any).ocrTaskId);expect(done.status,JSON.stringify(done)).toBe('completed');expect(calls-before).toBe(3);
  expect((await engine.getPage(result.slug))!.compiled_truth.startsWith(page!.compiled_truth)).toBe(true);expect(await engine.executeRaw('SELECT id,chunk_text FROM content_chunks WHERE id=ANY($1::int[]) ORDER BY id',[chunks.map((row:any)=>row.id)])).toEqual(chunks);
},120000);

test('纯图片文档也先保存，临时上传被清理后仍能完成后台识图',async()=>{
  cpu=0.95;const path=await word('scan',''),before=calls,result=await importOfficeFile(engine,path,'scan.docx',{...options,ocrOriginalPath:null} as any);expect(result.status).toBe('imported');expect(calls).toBe(before);expect((result as any).ocrPending).toBe(3);
  unlinkSync(path);cpu=0.1;const done=await finish((result as any).ocrTaskId);expect(done.status,JSON.stringify(done)).toBe('completed');expect((await engine.getPage(result.slug))!.compiled_truth).toContain('DeferredEvidence');expect(calls-before).toBe(3);
},120000);

test('后台开始前原始资料改变时拒绝识图和覆盖，已保存正文保留',async()=>{
  cpu=0.95;const path=await word('changed'),result=await importOfficeFile(engine,path,'changed.docx',options as any),body=(await engine.getPage(result.slug))!.compiled_truth,before=calls;await word('changed','External edit before OCR');cpu=0.1;
  const done=await finish((result as any).ocrTaskId);expect(done.status).toBe('failed');expect(calls).toBe(before);expect((await engine.getPage(result.slug))!.compiled_truth).toBe(body);
},120000);

test('失败项保留后台失败反馈，继续原任务只请求剩余图片',async()=>{
  cpu=0.95;const path=await word('retry'),before=calls,result=await importOfficeFile(engine,path,'retry.docx',options as any);failAt=before+2;cpu=0.1;
  expect((await finish((result as any).ocrTaskId)).status).toBe('failed');expect(calls-before).toBe(3);const kept=(await engine.getPage(result.slug))!.compiled_truth;failAt=-1;await runtime.retry('task-'+(result as any).ocrTaskId);
  expect((await finish((result as any).ocrTaskId)).status).toBe('completed');expect(calls-before).toBe(4);expect((await engine.getPage(result.slug))!.compiled_truth.startsWith(kept)).toBe(true);
},120000);

test('独立图片先保存文件与元数据，临时文件清理后仍能识图和重载',async()=>{
  cpu=0.95;const path=join(dir,'image.png'),canvas=createCanvas(40,40);canvas.getContext('2d').fillText('unique image',1,20);writeFileSync(path,canvas.toBuffer('image/png'));const before=calls;
  const result=await importImageFile(engine,path,'image.png',{sourceId:'default',noEmbed:true,forceOcr:true,deferDocumentOcr:true,ocrOriginalPath:null});expect(result.ocrPending).toBe(1);expect(calls).toBe(before);
  const original=(await engine.getPage('image.png'))!;const [type]=await engine.executeRaw<{dimensions:number}>("SELECT atttypmod dimensions FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding_image'");await engine.executeRaw('UPDATE content_chunks SET embedding_image=$2::vector WHERE page_id=$1',[original.id,JSON.stringify(Array.from({length:type.dimensions},(_,i)=>i===0?1:0))]);const kept=await engine.executeRaw('SELECT id,chunk_index,chunk_text,embedding_image::text FROM content_chunks WHERE page_id=$1',[original.id]);unlinkSync(path);cpu=0.1;
  expect((await finish(result.ocrTaskId!)).status).toBe('completed');expect(calls-before).toBe(1);const page=(await engine.getPage('image.png'))!;expect(page.compiled_truth).toContain('DeferredEvidence');expect(page.frontmatter.document_ocr_deferred).not.toBe(true);
  const [file]=await engine.executeRaw<{storage_path:string}>('SELECT storage_path FROM files WHERE page_id=$1',[page.id]);expect(existsSync(file.storage_path)).toBe(true);
  expect(await engine.executeRaw('SELECT id,chunk_index,chunk_text,embedding_image::text FROM content_chunks WHERE id=ANY($1::int[])',[kept.map((row:any)=>row.id)])).toEqual(kept);
},120000);

test('图片识别期间人工更新正文时保留修改，不覆盖原分块和向量',async()=>{
  cpu=0.95;const path=join(dir,'caption.png'),canvas=createCanvas(40,40);canvas.getContext('2d').fillText('caption',1,20);writeFileSync(path,canvas.toBuffer('image/png'));const result=await importImageFile(engine,path,'caption.png',{sourceId:'default',noEmbed:true,forceOcr:true,deferDocumentOcr:true});let release!:()=>void;holdOcr=new Promise<void>(done=>{release=done;});const before=calls;cpu=0.1;
  try{const until=Date.now()+60000;while(calls===before&&Date.now()<until)await Bun.sleep(60);expect(calls).toBe(before+1);await engine.executeRaw("UPDATE pages SET compiled_truth='人工补充说明' WHERE slug='caption.png' AND source_id='default'");}finally{holdOcr=undefined;release();}
  expect((await finish(result.ocrTaskId!)).status).toBe('failed');const page=(await engine.getPage('caption.png'))!;expect(page.compiled_truth).toBe('人工补充说明');expect(await engine.executeRaw('SELECT chunk_source FROM content_chunks WHERE page_id=$1',[page.id])).toEqual([{chunk_source:'image_asset'}]);
},120000);

test('后台待处理任务重启后继续，用户停止的任务不自动复活',async()=>{
  cpu=0.95;const path=await word('restart'),result=await importOfficeFile(engine,path,'restart.docx',options as any),before=calls;await runtime.close();await start();await Bun.sleep(200);expect(calls).toBe(before);cpu=0.1;
  expect((await finish(result.ocrTaskId!)).status).toBe('completed');expect(calls-before).toBe(3);
  cpu=0.95;const stopped=await importOfficeFile(engine,await word('stopped'),'stopped.docx',options as any);await runtime.cancel('task-'+stopped.ocrTaskId);await runtime.close();await start();cpu=0.1;await Bun.sleep(400);expect((await runtime.getRun('task-'+stopped.ocrTaskId))!.status).toBe('cancelled');expect(calls-before).toBe(3);
},120000);

test('产品导入先完成、慢识图不阻塞下一份资料，全部识图补齐后才请求向量',async()=>{
  cpu=0.95;await vectorConfiguration();
  const path=await word('pipeline'),before=calls,vectorBefore=embeddingCalls,eventStart=events.length;
  const task=await runtime.submitImport({path,sourceId:'default',documentOcr:true,noEmbed:false}),saved=await finish(Number(task.id.slice(5)));expect(saved.status,JSON.stringify(saved)).toBe('completed');expect((saved.result as any).ocrPending).toBe(3);expect(calls).toBe(before);expect(embeddingCalls).toBe(vectorBefore);
  let release!:()=>void;holdOcr=new Promise<void>(done=>{release=done;});cpu=0.1;
  try{
    const until=Date.now()+60000;while(calls===before&&Date.now()<until)await Bun.sleep(60);expect(calls).toBe(before+1);await runtime.adjustResourcePressure(true);
    const second=join(dir,'while-ocr.md');writeFileSync(second,'# Available now\n\n慢识图期间新增资料仍可先保存。');const next=await runtime.submitImport({path:second,sourceId:'default',noEmbed:true,documentOcr:false});expect((await finish(Number(next.id.slice(5)))).status).toBe('completed');expect((await engine.getPage('while-ocr'))!.compiled_truth).toContain('慢识图期间');expect(embeddingCalls).toBe(vectorBefore);
  }finally{holdOcr=undefined;release();await runtime.adjustResourcePressure(false);}
  const [page]=await engine.executeRaw<{id:number;job:number}>("SELECT id,(frontmatter->>'document_ocr_task_id')::int job FROM pages WHERE slug='pipeline.docx' AND source_id='default'");expect((await finish(page.job)).status).toBe('completed');
  const until=Date.now()+60000;while(Date.now()<until){const [pending]=await engine.executeRaw<{n:number}>('SELECT count(*)::int n FROM content_chunks WHERE page_id=$1 AND embedding IS NULL',[page.id]);if(!pending.n)break;await Bun.sleep(100);}
  expect(calls-before).toBe(3);expect(embeddingCalls).toBeGreaterThan(vectorBefore);const sequence=events.slice(eventStart);expect(sequence.indexOf('embed')).toBeGreaterThan(sequence.lastIndexOf('ocr'));expect((await runtime.getRun(task.id))!.result).toMatchObject({ocrPending:0,ocrFailed:0});
},180000);

test('同资料导入、同步、快速维护共用待识图任务，未补齐前不提取知识或向量化',async()=>{
  cpu=0.95;const chain=join(root,'chain');mkdirSync(chain);await engine.executeRaw("UPDATE sources SET config=config||'{\"syncEnabled\":false}'::jsonb WHERE id='default'");await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('chain','完整链路',$1,'{\"syncEnabled\":true,\"includeOffice\":true}'::jsonb)",[chain]);
  const original=await word('chain-input','保留这一份足够长的原始文字，图片文字补齐前不能进入后续提炼与向量化。'.repeat(8)),path=join(chain,'chain.docx');writeFileSync(path,readFileSync(original));unlinkSync(original);
  await engine.executeRaw("DELETE FROM config WHERE key='dream.entity_capture.pending.default'");await engine.setConfig('dream.entity_capture.enabled','true');await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:isolated-office-ocr':{input:1,output:1},'custom-openai:deferred-embed':{input:1,output:0}}));
  const before=calls,vectorBefore=embeddingCalls,captureBefore=captureSources.filter(text=>text.includes('chain.docx')).length,offset=events.length,result=await importOfficeFile(engine,path,'chain.docx',{...options,sourceId:'chain',deferredOcrVectors:true});
  const sync=await finish(Number((await runtime.submitSync()).id.slice(5)));expect(sync.status,JSON.stringify(sync.result)).toBe('completed');
  const maintenance=await runtime.submitDream({preset:'quick',sourceId:'chain'},'scheduled');const waitUntil=Date.now()+60000;while(Date.now()<waitUntil){const current=await runtime.getRun(maintenance.id);if(current?.status==='queued'&&current.product?.stage.includes('后台识图'))break;await Bun.sleep(100);}expect((await runtime.getRun(maintenance.id))!.product!.stage,JSON.stringify(await engine.executeRaw("SELECT id,name,status,error_text,progress->'product'->>'stage' stage,data->'task'->'input'->>'phase' phase,data->'task'->'input'->>'sourceId' source,data->>'waitingForOcr' waiting FROM minion_jobs WHERE status NOT IN ('completed','cancelled','failed','dead')"))).toContain('资料已保存');
  expect(calls).toBe(before);expect(embeddingCalls).toBe(vectorBefore);expect(captureSources.filter(text=>text.includes('chain.docx')).length).toBe(captureBefore);expect(await selectEntityCaptureCandidates(engine,'chain')).toHaveLength(0);
  const [queued]=await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM minion_jobs WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->>'sourceId'='chain'");expect(queued.n).toBe(1);
  cpu=0.1;expect((await finish(result.ocrTaskId!)).status).toBe('completed');expect((await finish(Number(maintenance.id.slice(5)))).status).toBe('completed');expect(calls-before).toBe(3);expect(captureSources.filter(text=>text.includes('chain.docx')).length).toBeGreaterThan(captureBefore);const sequence=events.slice(offset);expect(sequence.indexOf('chain_capture')).toBeGreaterThan(sequence.lastIndexOf('ocr'));
},180000);

test('维护产生的后台识图仍计入原任务总预算，提额继续后费用和向量合并到原任务',async()=>{
  await vectorConfiguration();
  await engine.setConfig('dream.entity_capture.enabled','false');await engine.setConfig('dream.task_budget_cny','0.000000001');const folder=join(root,'budget');mkdirSync(folder);await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('ocr-budget','识图费用验收',$1,'{\"includeOffice\":true}'::jsonb)",[folder]);
  const file=await word('budget-input');writeFileSync(join(folder,'budget.docx'),readFileSync(file));unlinkSync(file);cpu=0.1;const before=calls,vectorBefore=embeddingCalls,task=await runtime.submitDream({preset:'quick',sourceId:'ocr-budget'},'scheduled');
  let childId=0;const until=Date.now()+60000;while(Date.now()<until){const [child]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1",[task.id.slice(5)]);if(child){childId=child.id;break;}await Bun.sleep(100);}expect(childId).toBeGreaterThan(0);
  const rejected=await finish(childId);expect(rejected.status).toBe('failed');expect((rejected.result as any).reason).toBe('task_budget');expect(calls).toBe(before);expect(embeddingCalls).toBe(vectorBefore);
  await engine.setConfig('dream.task_budget_cny','1');const raised=Date.now()+60000;while(Date.now()<raised){const [parent]=await engine.executeRaw<{cap:string}>("SELECT data->'taskBudget'->>'capCny' cap FROM minion_jobs WHERE id=$1",[Number(task.id.slice(5))]);if(Number(parent.cap)===1)break;await Bun.sleep(100);}
  await runtime.retry('task-'+childId);expect((await finish(childId)).status).toBe('completed');const done=await finish(Number(task.id.slice(5)));expect(done.status,JSON.stringify(done.result)).toBe('completed');expect((done.result as any).budget.calls).toBe(calls-before+embeddingCalls-vectorBefore);expect((done.result as any).budget.spentCny).toBeGreaterThan(0);expect((done.result as any).budget.capCny).toBe(1);
},180000);

test('停止维护同时停止它的识图子任务，重启保持停止，继续原维护才恢复',async()=>{
  await vectorConfiguration();await engine.setConfig('dream.task_budget_cny','1');
  cpu=0.95;const folder=join(root,'owned-stop');mkdirSync(folder);await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('owned-stop','停止验收',$1,'{\"includeOffice\":true}'::jsonb)",[folder]);const file=await word('owned-stop-input');writeFileSync(join(folder,'owned.docx'),readFileSync(file));unlinkSync(file);
  const before=calls,task=await runtime.submitDream({preset:'quick',sourceId:'owned-stop'},'scheduled');let childId=0;const until=Date.now()+60000;while(Date.now()<until){const [child]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1",[task.id.slice(5)]);if(child){childId=child.id;break;}await Bun.sleep(100);}expect(childId).toBeGreaterThan(0);
  await runtime.cancel(task.id);expect((await runtime.getRun('task-'+childId))!.status).toBe('cancelled');await runtime.close();await start();cpu=0.1;await Bun.sleep(300);expect((await runtime.getRun(task.id))!.status).toBe('cancelled');expect((await runtime.getRun('task-'+childId))!.status).toBe('cancelled');expect(calls).toBe(before);
  await runtime.retry(task.id);const done=await finish(Number(task.id.slice(5)));expect(done.status,JSON.stringify(done.result)).toBe('completed');expect(calls-before).toBe(3);expect((await runtime.getRun('task-'+childId))!.status).toBe('completed');
},180000);
