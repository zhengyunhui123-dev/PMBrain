import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import { importFile } from '../src/core/import-file.ts';
import { configPath } from '../src/core/config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { DEFAULT_PHASES } from '../src/core/cycle.ts';
import { runQuickMaintenance } from '../src/core/quick-maintenance.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { DREAM_TASK_TIMEOUT_KEY, DEFAULT_PRODUCT_TASK_TIMEOUT_MS } from '../src/product/tasks/timeout.ts';

let engine:BrainEngine, runtime:ProductTaskRuntime, root:string, server:ReturnType<typeof Bun.serve>;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let calls=0;
let timeoutMode=false, holdTimeout=false, releaseTimeout:(()=>void)|undefined;
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-imported-entities-'));
  for(const key of keys)delete process.env[key];
  process.env.PMBRAIN_HOME=root; process.env.GBRAIN_HOME=root; mkdirSync(join(root,'.pmbrain'));
  const dimensions=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL?1536:1024;
  const steps=[
    ['brain_search',{query:'刘慈欣'}],
    ['brain_capture_entities',{entities:[{slug:'people/liu',content:'---\ntitle: 刘慈欣\ntype: person\n---\n刘慈欣创作了三体。[Source: notes/input] [[auto-capture:notes/input]]'}],relations:[]}],
  ] as const;
  server=Bun.serve({port:0,async fetch(req){
    const body=await req.json() as {input?:string|string[];tools?:Array<{function:{name:string}}>};
    if(new URL(req.url).pathname.endsWith('/embeddings'))return Response.json({object:'list',data:(Array.isArray(body.input)?body.input:[body.input]).map((_,index)=>({object:'embedding',index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'relation-embedding',usage:{prompt_tokens:2,total_tokens:2}});
    if(timeoutMode){
      calls++;
      if(holdTimeout)await new Promise<void>(resolve=>{releaseTimeout=resolve;});
      return Response.json({id:`timeout-${calls}`,object:'chat.completion',created:1,model:'relation-test',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({entities:[],relations:[],no_entities:true})}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
    }
    const step=steps[calls++];
    const name=step&&body.tools?.find(tool=>tool.function.name===step[0])?.function.name;
    return Response.json({id:`chat-${calls}`,object:'chat.completion',created:1,model:'relation-test',choices:[{
      index:0,finish_reason:step?'tool_calls':'stop',message:step?{role:'assistant',content:null,tool_calls:[{id:`call-${calls}`,type:'function',function:{name:name??step[0],arguments:JSON.stringify(step[1])}}]}:{role:'assistant',content:JSON.stringify({entities:['people/liu'],relations:[]})},
    }],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
  }});
  const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(url)assertSafeE2eDatabaseUrl(url);
  writeFileSync(configPath(),JSON.stringify({engine:url?'postgres':'pglite',custom_openai_api_key:'isolated-test-only',embedding_model:'custom-openai:relation-embedding',embedding_dimensions:dimensions,
    provider_base_urls:{'custom-openai':server.url.origin+'/v1'},models:{default:'custom-openai:relation-test'},
    model_usage:{generative_enabled:true,embedding_enabled:true},desktop:{knowledge_directory:root}}));
  engine=url?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(url?{database_url:url}:{}); await engine.initSchema();
  await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:relation-test':{input:1,output:1},'custom-openai:relation-embedding':{input:1,output:0}}));
  await engine.executeRaw("DELETE FROM pages WHERE source_id='auto-capture'");
  await engine.executeRaw("DELETE FROM minion_jobs WHERE data->'task'->'input'->>'sourceId'='auto-capture' OR data->>'source_id'='auto-capture'");
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('auto-capture','Auto', $1) ON CONFLICT(id) DO UPDATE SET local_path=EXCLUDED.local_path",[root]);
},60_000);
afterAll(async()=>{
  releaseTimeout?.();
  await runtime?.close(); await engine?.disconnect(); server?.stop(true);
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  if(root&&resolve(root).startsWith(resolve(tmpdir())+sep)&&root.includes('pmbrain-imported-entities-'))rmSync(root,{recursive:true,force:true});
},60_000);

test('native Dream stays unchanged while explicitly scoped quick maintenance includes ingestion',async()=>{
  expect(DEFAULT_PHASES).not.toContain('capture_entities');
  const report=await runQuickMaintenance(engine,{brainDir:root,dryRun:true,sourceId:'auto-capture',captureEntitySlugs:['notes/input']});
  expect(report.phases.map(phase=>phase.phase)).toContain('capture_entities');
  expect(calls).toBe(0);
});

test('old automatic capture is paused on restart and saved time settings reach manual and scheduled tasks',async()=>{
  const queue=new MinionQueue(engine);
  const old=await queue.add('pmbrain-product-task',{kind:'dream_capture_entities',trigger:'scheduled',task:{type:'dream',input:{phase:'capture_entities',sourceId:'auto-capture',slugs:['notes/old']}}},{queue:'pmbrain-product'});
  await engine.setConfig('dream.entity_capture.pending.auto-capture',JSON.stringify({nonce:'legacy',slugs:['notes/old']}));
  runtime=new ProductTaskRuntime(engine);await runtime.start();await Bun.sleep(250);
  expect((await queue.getJob(old.id))?.status).toBe('paused');expect(calls).toBe(0);
  expect((await runtime.getRun(`task-${old.id}`))?.error).toContain('旧版自动实体识别已停用');
  expect(await engine.getConfig('dream.entity_capture.pending.auto-capture')).toContain('notes/old');
  await engine.setConfig(DREAM_TASK_TIMEOUT_KEY,'420000');
  for(const trigger of ['manual','scheduled'] as const){
    const run=await runtime.submitDream({phase:'backlinks',sourceId:'auto-capture',dryRun:true},trigger);
    const saved=await queue.getJob(Number(run.id.slice(5)));
    expect(saved?.timeout_ms).toBe(420000);
    expect((saved?.data.task as {input:{timeoutMs:number}}).input.timeoutMs).toBe(420000);
  }
  const overridden=await runtime.submitDream({preset:'quick',sourceId:'auto-capture',dryRun:true,timeoutMs:180000});
  expect((await queue.getJob(Number(overridden.id.slice(5))))?.timeout_ms).toBe(180000);
  await runtime.close();runtime=new ProductTaskRuntime(engine);await runtime.start();
  const reloaded=await runtime.submitDream({preset:'quick',sourceId:'auto-capture',dryRun:true});
  expect((await queue.getJob(Number(reloaded.id.slice(5))))?.timeout_ms).toBe(420000);
  expect((await queue.getJob(old.id))?.status).toBe('paused');expect(calls).toBe(0);
  await runtime.close();await engine.setConfig(DREAM_TASK_TIMEOUT_KEY,'');
  expect(DEFAULT_PRODUCT_TASK_TIMEOUT_MS).toBe(21600000);
  await engine.executeRaw("DELETE FROM minion_jobs WHERE queue='pmbrain-product'");
  await engine.executeRaw("DELETE FROM config WHERE key='dream.entity_capture.pending.auto-capture'");
},30000);

test('legacy quick task resumes with its original ID, native receipts and archived capture failure',async()=>{
  const queue=new MinionQueue(engine);
  const lint={phase:'lint',status:'warn',duration_ms:37,summary:'legacy lint',details:{}};
  const sync={phase:'sync',status:'ok',duration_ms:91,summary:'legacy sync',details:{}};
  const capture={phase:'capture_entities',status:'warn',duration_ms:777,summary:'legacy capture failure',details:{pages_remaining:2}};
  const checkpoint={phases:{'auto-capture':[lint,sync,capture]},reports:{},captureRequests:{'auto-capture':['notes/legacy']}};
  const old=await queue.add('pmbrain-product-task',{kind:'dream_quick',trigger:'manual',task:{type:'dream',input:{preset:'quick',sourceId:'auto-capture',dryRun:true,checkpoint}}},{queue:'pmbrain-product'});
  await engine.executeRaw("UPDATE minion_jobs SET status='paused' WHERE id=$1",[old.id]);
  runtime=new ProductTaskRuntime(engine);await runtime.start();
  expect((await runtime.retry(`task-${old.id}`))?.id).toBe(`task-${old.id}`);
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(['completed','failed','dead'].includes((await queue.getJob(old.id))?.status??''))break;await Bun.sleep(50);}
  const saved=await queue.getJob(old.id);
  expect(saved?.status,saved?.error_text??'').toBe('completed');
  expect((saved?.result as {phases:unknown[]}).phases).toContainEqual(sync);
  expect((saved?.data.task as {input:{checkpoint:typeof checkpoint & {retiredCapture:Record<string,{phases:unknown[]}>}}}).input.checkpoint.retiredCapture['auto-capture'].phases).toContainEqual(capture);
  expect(calls).toBe(0);
  await runtime.close();await engine.executeRaw("DELETE FROM minion_jobs WHERE queue='pmbrain-product'");
},30000);

test('ordinary core import persists bounded ingestion and runtime restart completes it once',async()=>{
  const file=join(root,'input.md');
  writeFileSync(file,'---\ntitle: 导入资料\ntype: note\n---\n刘慈欣创作了三体，这是导入的中文资料。');
  expect((await importFile(engine,file,'notes/input.md',{sourceId:'auto-capture',noEmbed:true})).status).toBe('imported');
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue='pmbrain-product' AND data->'task'->'input'->>'sourceId'='auto-capture'")).toHaveLength(0);
  expect(await engine.getConfig('dream.entity_capture.pending.auto-capture')).toContain('notes/input');
  runtime=new ProductTaskRuntime(engine); await runtime.start();
  let job:{id:number;status:string;error_text:string|null}|undefined;
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    [job]=await engine.executeRaw<typeof job & {}>("SELECT id,status,error_text FROM minion_jobs WHERE queue='pmbrain-product' AND data->'task'->'input'->>'sourceId'='auto-capture' ORDER BY id DESC LIMIT 1");
    if(job&&['completed','dead','failed','paused'].includes(job.status))break;
    await Bun.sleep(50);
  }
  expect(job?.status,job?.error_text??JSON.stringify(await runtime.listRuns())).toBe('completed');
  expect((await engine.getPage('people/liu',{sourceId:'auto-capture'}))?.title).toBe('刘慈欣');
  const links=await engine.executeRaw<{from_slug:string;to_slug:string}>('SELECT f.slug AS from_slug,t.slug AS to_slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1',['auto-capture']);
  expect(links).toContainEqual({from_slug:'notes/input',to_slug:'people/liu'});
  const count=calls;
  await runtime.close(); runtime=new ProductTaskRuntime(engine); await runtime.start();
  await Bun.sleep(300);
  expect(calls).toBe(count);
  expect((await runtime.listRuns()).some(run=>run.kind==='dream_capture_entities'&&run.trigger==='scheduled'&&run.status==='completed')).toBe(true);
  expect(await engine.getConfig('dream.entity_capture.pending.auto-capture')).toBeNull();
},60_000);

test('saved execution timeout aborts an in-flight model call; retry keeps original timeout and saved knowledge',async()=>{
  timeoutMode=true;holdTimeout=true;
  await engine.putPage('notes/timer',{type:'note',title:'超时原文',compiled_truth:'这是超时测试原文，停止后必须保留。',timeline:'',frontmatter:{}},{sourceId:'auto-capture'});
  await engine.setConfig(DREAM_TASK_TIMEOUT_KEY,'5000');
  const run=await runtime.submitDream({phase:'capture_entities',sourceId:'auto-capture',slugs:['notes/timer']});
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(['failed','cancelled'].includes((await runtime.getRun(run.id))?.status??''))break;await Bun.sleep(50);}
  expect((await runtime.getRun(run.id))?.status).toBe('failed');
  expect(releaseTimeout).toBeDefined();
  expect((await engine.getPage('notes/timer',{sourceId:'auto-capture'}))?.compiled_truth).toContain('停止后必须保留');
  expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
  holdTimeout=false;releaseTimeout?.();
  await engine.setConfig(DREAM_TASK_TIMEOUT_KEY,'10000');
  expect((await runtime.retry(run.id))?.id).toBe(run.id);
  const resumedDeadline=Date.now()+15000;
  while(Date.now()<resumedDeadline){if(['completed','failed'].includes((await runtime.getRun(run.id))?.status??''))break;await Bun.sleep(50);}
  expect((await runtime.getRun(run.id))?.status).toBe('completed');
  expect((await new MinionQueue(engine).getJob(Number(run.id.slice(5))))?.timeout_ms).toBe(5000);
  await engine.setConfig(DREAM_TASK_TIMEOUT_KEY,'');timeoutMode=false;
},35000);
