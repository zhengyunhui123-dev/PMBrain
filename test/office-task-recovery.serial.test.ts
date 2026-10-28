import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {createCanvas} from '@napi-rs/canvas';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import {ProductTaskRuntime} from '../src/product/tasks/runtime';
import {configPath} from '../src/core/config';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';
import {taskCanRetry,taskStatus} from '../admin/src/product/task-presentation';
let root:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>,calls=0,fail=true,cpu=.1;
const resources={background:{sample:()=>({cpuBusyRatio:cpu,bytes:1024**3,availableBytes:12*1024**3,totalBytes:16*1024**3,systemIdleSeconds:100})}};
const database=process.env.PMBRAIN_OFFICE_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
async function connect(){
  engine=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});
}
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-office-task-'));
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  mkdirSync(join(root,'.pmbrain'));
  if(database)assertSafeE2eDatabaseUrl(database);
  server=Bun.serve({port:0,async fetch(req){
    if(!new URL(req.url).pathname.endsWith('/chat/completions'))return new Response('not found',{status:404});
    await req.json();calls++;console.log('识图模型夹具请求',JSON.stringify({calls,fail}));
    return Response.json({id:`ocr-${calls}`,object:'chat.completion',created:1,model:'isolated-office-ocr',choices:[{index:0,finish_reason:fail&&calls>=2?'length':'stop',message:{role:'assistant',content:`Recovered image ${calls}`}}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}});
  }});
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',...(database?{database_url:database}:{database_path:join(root,'database')}),custom_openai_api_key:'isolated-only',models:{default:'custom-openai:isolated-office-ocr'},provider_base_urls:{'custom-openai':server.url.origin+'/v1'},model_usage:{generative_enabled:true,embedding_enabled:false}}));
  await connect();await engine.initSchema();await engine.setConfig('dream.entity_capture.enabled','false');
  runtime=new ProductTaskRuntime(engine,resources);await runtime.start();
},90_000);
afterAll(async()=>{
  await runtime?.close();await engine?.disconnect();server?.stop(true);
  for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-office-task-'))throw new Error('临时目录校验失败');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
},60_000);
async function docx(path:string,text:string,images:number){
  const zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for(let i=0;i<images;i++){const canvas=createCanvas(32,32);canvas.getContext('2d').fillStyle='#'+createHash('sha256').update(path+i).digest('hex').slice(0,6);canvas.getContext('2d').fillRect(0,0,32,32);zip.file(`word/media/image${i}.png`,canvas.toBuffer('image/png'));}
  writeFileSync(path,await zip.generateAsync({type:'uint8array'}));
}
async function source(name:string){
  const directory=join(root,name);mkdirSync(directory);const sourceId=`office-task-${name}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$2,$3,$4::jsonb)',[sourceId,name,directory,{syncEnabled:false}]);return {directory,sourceId};
}
async function finish(id:string){
  const deadline=Date.now()+180_000;
  let reported=Date.now();
  while(Date.now()<deadline){const row=await runtime.getRun(id);if(row&&!['running','queued'].includes(row.status))return row;if(Date.now()-reported>15000){reported=Date.now();console.log('任务恢复进度',JSON.stringify({id,calls,status:row?.status,stage:row?.product?.stage,activity:row?.product?.activity,tail:row?.stdout?.slice(-350),jobs:await engine.executeRaw("SELECT id,name,status,error_text,progress->'product'->>'stage' stage FROM minion_jobs WHERE status NOT IN ('completed','failed','dead','cancelled')")}));}await Bun.sleep(100);}
  throw new Error(`任务未结束：${id} ${JSON.stringify(await engine.executeRaw("SELECT id,name,status,error_text,progress->'product'->>'stage' stage FROM minion_jobs"))}`);
}
test('真实任务 IPC、软件重启和原任务重试只补失败图片，成功文件再次导入不再调用模型',async()=>{
  const f=await source('retry');await docx(join(f.directory,'report.docx'),'Native text retained',2);
  const first=await runtime.submitImport({path:f.directory,sourceId:f.sourceId,noEmbed:true,documentOcr:true,includeOffice:true});
  const imported=await finish(first.id);expect(imported.status).toBe('completed');expect(imported.result).toMatchObject({ocrPending:2,errors:0});const childId='task-'+(imported.result as any).ocrTaskIds[0];const stopped=await finish(childId);expect(stopped.status).toBe('failed');const shown=stopped as unknown as Parameters<typeof taskStatus>[0];expect(taskCanRetry(shown)).toBe(true);const parent=await runtime.getRun(first.id) as Parameters<typeof taskStatus>[0];expect(taskStatus(parent)).toBe('导入成功');expect(parent.product?.stage).toContain('识图未完成');
  const saved=await engine.getPage('report.docx',{sourceId:f.sourceId});expect(saved!.compiled_truth).toContain('Native text retained');expect(saved!.compiled_truth).toContain('Recovered image 1');
  const prior=calls;await runtime.close();await engine.disconnect();await connect();runtime=new ProductTaskRuntime(engine,resources);await runtime.start();fail=false;
  await runtime.retry(childId);const recovered=await finish(childId);expect(recovered.status).toBe('completed');expect(calls-prior).toBe(1);expect((await runtime.getRun(first.id))!.result).toMatchObject({ocrPending:0});
  expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('Recovered image 1');
  const count=calls;const repeated=await runtime.submitImport({path:f.directory,sourceId:f.sourceId,noEmbed:true,documentOcr:true,includeOffice:true});expect((await finish(repeated.id)).result).toMatchObject({unchanged:1,errors:0});expect(calls).toBe(count);
  if(!database){await Bun.write('.codex/import-repair/runtime-partial.json',JSON.stringify(stopped));await Bun.write('.codex/import-repair/runtime-recovered.json',JSON.stringify(recovered));}
},240_000);
test('后台识图不阻塞资料保存，停止识图后同大小同时间的修改再次导入仍更新正文',async()=>{
  const f=await source('cancel');const firstPath=join(f.directory,'2026-10-30-first.docx');await docx(firstPath,'FIRST content',0);const fixed=new Date('2026-01-01T00:00:00Z');utimesSync(firstPath,fixed,fixed);
  await docx(join(f.directory,'2026-10-29-second.docx'),'Second content',1);fail=false;cpu=.95;const prior=calls;
  const started=await runtime.submitImport({path:f.directory,sourceId:f.sourceId,noEmbed:true,documentOcr:true,includeOffice:true});
  const parent=await finish(started.id);expect(parent.status).toBe('completed');expect(calls).toBe(prior);
  expect((await engine.getPage('2026-10-30-first.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('FIRST content');
  const childId='task-'+(parent.result as any).ocrTaskIds[0];const before=statSync(firstPath);await runtime.cancel(childId);
  await docx(firstPath,'OTHER content',0);utimesSync(firstPath,fixed,fixed);expect(statSync(firstPath).size).toBe(before.size);expect(statSync(firstPath).mtimeMs).toBe(before.mtimeMs);
  const repeated=await runtime.submitImport({path:f.directory,sourceId:f.sourceId,noEmbed:true,documentOcr:true,includeOffice:true});expect((await finish(repeated.id)).status).toBe('completed');expect((await engine.getPage('2026-10-30-first.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('OTHER content');expect((await runtime.getRun(childId))!.status).toBe('cancelled');cpu=.1;await runtime.retry(childId);expect((await finish(childId)).status).toBe('completed');
},240_000);
