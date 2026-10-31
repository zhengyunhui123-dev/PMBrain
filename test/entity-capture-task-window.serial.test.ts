import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {ProductTaskRuntime} from '../src/product/tasks/runtime.ts';
import {configureGateway,resetGateway} from '../src/core/ai/gateway.ts';
import {buildGatewayConfig} from '../src/core/ai/gateway-config.ts';
import {configPath} from '../src/core/config.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';
import {requestImportedEntityCapture} from '../src/core/pmbrain-adapters/entity-capture-request.ts';

const url=process.env.PMBRAIN_TASK_WINDOW_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
const previous=keys.map(key=>process.env[key]);
let home:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>;
let requests=0,held=false,omitUsage=false,zeroUsage=false,nextCapture:Record<string,unknown>|null=null;const releases=new Set<()=>void>();const prompts:string[]=[];
beforeAll(async()=>{
  home=mkdtempSync(join(tmpdir(),'pmbrain-task-window-'));
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=home;process.env.GBRAIN_HOME=home;
  mkdirSync(join(home,'.pmbrain'));
  server=Bun.serve({port:0,async fetch(req){const body:any=await req.json(),route=new URL(req.url).pathname;
    if(route.endsWith('/embeddings')){
      const inputs=Array.isArray(body.input)?body.input:[body.input??''];
      const dimensions=Number(body.dimensions??1024);
      return Response.json({object:'list',model:body.model,data:inputs.map((value:any,index:number)=>({object:'embedding',index,embedding:Array.from({length:dimensions},(_,offset)=>((String(value).length+index+offset)%97)/100)})),usage:{prompt_tokens:1,total_tokens:1}});
    }
    if(!route.endsWith('/chat/completions'))throw new Error(`unexpected model endpoint: ${route}`);
    requests++;
    if(held)await new Promise<void>(resolve=>releases.add(resolve));
    const nativeTools=(body.tools??[]).map((tool:any)=>tool.function?.name).filter((name:any)=>typeof name==='string');
    const requestText=JSON.stringify(body);
    prompts.push(requestText);
    const nativeToolName=['brain_capture_entities','brain_complete_ingest'].find(name=>nativeTools.includes(name));
    const toolName=nativeToolName??(requestText.includes('Use only these definitions:')
      ?['brain_capture_entities','brain_complete_ingest'].find(name=>requestText.includes(name))
      :undefined);
    if(!toolName)throw new Error(`entity capture request did not expose a completion tool: ${requestText.slice(0,500)}`);
    const args={entities:[],relations:[],no_entities:true};
    const singlePass=requestText.includes('只输出一个 JSON 对象')&&requestText.includes('timeline_entries');
    const output=nextCapture??{...args,timeline_entries:[]};nextCapture=null;
    const choice=singlePass
      ?{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}
      :nativeTools.includes(toolName)
      ?{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'finish-'+requests,type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]}}
      :{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({tool_calls:[{name:toolName,arguments:args}]})}};
    return Response.json({id:'window-'+requests,object:'chat.completion',created:1,model:body.model,choices:[choice],...(omitUsage?{}:{usage:zeroUsage?{prompt_tokens:0,completion_tokens:0,total_tokens:0}:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})});
  }});
  const config={engine:url?'postgres' as const:'pglite' as const,database_path:join(home,'test.pglite'),embedding_model:'custom-openai:window-test',embedding_dimensions:1024,custom_openai_api_key:'isolated-window-test',provider_base_urls:{'custom-openai':server.url.origin+'/v1'},'models.dream.synthesize':'custom-openai:window-test',model_usage:{generative_enabled:true,embedding_enabled:false},desktop:{knowledge_directory:home,model_services:[{id:'fixture',provider:'custom-openai',name:'隔离远程',baseUrl:'https://fixture.invalid/v1',apiKey:'isolated-window-test',enabled:true,models:[{id:'window-test',name:'window-test',kind:'chat' as const,group:'fixture',capabilities:[],inputPriceCny:1,outputPriceCny:1}]}]}};
  writeFileSync(configPath(),JSON.stringify(config));configureGateway(buildGatewayConfig(config));
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(url?{database_url:url}:{database_path:config.database_path});await engine.initSchema();
  if(url){await resetPgliteState(engine as any);await engine.setConfig('version','133');}
  await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:window-test':{input:1,output:1}}));
  await engine.setConfig('dream.entity_capture.cost_cap_cny','1000');
  await engine.setConfig('dream.entity_capture.price.input_cny_per_million','1');
  await engine.setConfig('dream.entity_capture.price.output_cny_per_million','1');
  runtime=new ProductTaskRuntime(engine);await runtime.start();
},60000);
afterAll(async()=>{
  for(const release of releases)release();releases.clear();
  await runtime?.close();await engine?.disconnect();server?.stop(true);resetGateway();
  for(const [index,key] of keys.entries())if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];
  if(home)rmSync(home,{recursive:true,force:true});
},60000);
async function waitFor(predicate:()=>Promise<boolean>,ms=100000){const until=Date.now()+ms;while(Date.now()<until){if(await predicate())return;await Bun.sleep(100);}throw new Error(`isolated task window did not reach its expected state: ${JSON.stringify({requests,runs:await runtime.listRuns()})}`);}

test('33 分块自动归还窗口并继续同一个父任务，累计用量和完成数不丢失',async()=>{
  for(let index=0;index<33;index++)await engine.putPage(`notes/window-${index}`,{type:'note',title:`合成窗口记录${index}`,compiled_truth:'这是窗口验收用的工作核对记录，只包含日常事项，不含值得单独建档的专有名称。'.repeat(3),frontmatter:{}});
  const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default'});
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
  const done=(await runtime.getRun(run.id))!;
  expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');expect(requests).toBe(33);
  const result=done.result as any,capture=result.phases.find((phase:any)=>phase.phase==='capture_entities');
  expect(capture.details.chunks_processed).toBe(33);expect(capture.details.input_tokens).toBe(330);expect(capture.details.output_tokens).toBe(165);
  expect(capture.details.cost_cny).toBeCloseTo(.000495,6);expect(capture.details.cost_cap_cny).toBe(1000);
  const [last]=await engine.executeRaw<{cap:number}>("SELECT (data->'usage_limits'->>'cost_cny')::double precision cap FROM minion_jobs WHERE data ? 'ingest_context' ORDER BY id DESC LIMIT 1");
  expect(last!.cap).toBeCloseTo(999.99952,6);
  const parents=await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue='pmbrain-product'");expect(parents).toHaveLength(1);
  const second=await runtime.submitDream({phase:'capture_entities',sourceId:'default'});
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(second.id))!.status));
  expect((await runtime.getRun(second.id))!.status).toBe('completed');expect(requests).toBe(33);
},120000);

test('窗口中的模型请求停止后不继续领取，刷新保持停止，原任务可手动继续',async()=>{
  await engine.putPage('notes/held-window',{type:'note',title:'隔离停止记录',compiled_truth:'这是一条用于停止与继续验收的合成工作记录，没有需要建档的名称。'.repeat(3),frontmatter:{}});
  held=true;const before=requests;
  const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default'});
  await waitFor(async()=>releases.size>0);
  const start=performance.now();await runtime.requestCancel(run.id);expect(performance.now()-start).toBeLessThan(1000);
  await waitFor(async()=>(await runtime.getRun(run.id))!.status==='cancelled');
  await Bun.sleep(1200);expect(requests).toBe(before+1);expect((await runtime.listRuns()).find(row=>row.id===run.id)!.status).toBe('cancelled');
  held=false;for(const release of releases)release();releases.clear();
  const resumed=(await runtime.retry(run.id))!;expect(resumed.id).toBe(run.id);
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
  expect((await runtime.getRun(run.id))!.status).toBe('completed');
},120000);

test('产品深度整理只识别四类实体，相同正文与备份只提交一次',async()=>{
  const body='这是隔离深度整理的项目资料，记录验收负责人和组织安排。'.repeat(4);
  for(const slug of ['notes/deep-original','notes/备份/deep-copy']){
    const page={type:'note' as const,title:slug,compiled_truth:body,frontmatter:{}};
    await engine.putPage(slug,page);
    await requestImportedEntityCapture(engine,'default',{slug,...page});
  }
  const before=requests;
  const submitted=await runtime.submitDream({preset:'full',sourceId:'default'});
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(submitted.id))!.status));
  const done=(await runtime.getRun(submitted.id))!;
  expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');
  expect(requests-before).toBe(1);
  expect(prompts[before]).toContain('person、company、organization、project');
  expect(prompts[before]).not.toContain('person、company、organization、project、concept');
  expect(JSON.parse(prompts[before]!).tools).toBeUndefined();
},120000);

test('产品任务一次提取补充旧项目并新建人员，重复维护不再请求模型',async()=>{
  const slug='notes/entity-new-and-old',project='projects/星程项目',person='people/张三';
  const body='2026-10-30，星程项目启动，张三负责星程项目验收。';
  const page={type:'note' as const,title:'隔离新资料',compiled_truth:body,frontmatter:{}};
  await engine.putPage(slug,page);
  await requestImportedEntityCapture(engine,'default',{slug,...page});
  await engine.putPage(project,{type:'project',title:'星程项目',compiled_truth:'原有人工记录必须保留。',frontmatter:{}});
  nextCapture={entities:[
    {slug:project,content:`---\ntitle: 星程项目\ntype: project\n---\n星程项目于 2026-10-30 启动。[Source: ${slug}]`},
    {slug:person,content:`---\ntitle: 张三\ntype: person\n---\n张三负责星程项目验收。[Source: ${slug}]`},
  ],reused_entities:[],relations:[{from:person,to:project,link_type:'mentions',evidence:'张三负责星程项目验收。'}],timeline_entries:[{slug:project,date:'2026-10-30',summary:'星程项目启动'}]};
  const before=requests;
  try{
    const submitted=await runtime.submitDream({preset:'full',sourceId:'default',slugs:[slug]});
    await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(submitted.id))!.status));
    const done=(await runtime.getRun(submitted.id))!;
    expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');expect(requests-before).toBe(1);
    const updated=await engine.getPage(project),created=await engine.getPage(person);
    expect(updated?.compiled_truth).toContain('原有人工记录必须保留');expect(updated?.compiled_truth).toContain('启动');
    expect(created?.compiled_truth).toContain('验收');
    const backlinks=await engine.executeRaw<{n:number}>("SELECT count(DISTINCT f.slug)::int n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.slug=ANY($1::text[]) AND t.slug=$2",[[project,person],slug]);
    expect(Number(backlinks[0]?.n)).toBe(2);
    const timeline=()=>engine.executeRaw("SELECT t.id FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND t.date='2026-10-30'",[project]);
    const timelineBefore=await timeline();expect(timelineBefore.length).toBeGreaterThan(0);
    const [linksBefore]=await engine.executeRaw<{n:number}>('SELECT count(*)::int n FROM links');
    const again=await runtime.submitDream({preset:'full',sourceId:'default',slugs:[slug]});
    await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(again.id))!.status));
    expect((await runtime.getRun(again.id))!.status).toBe('completed');expect(requests-before).toBe(1);
    const [linksAfter]=await engine.executeRaw<{n:number}>('SELECT count(*)::int n FROM links');expect(linksAfter?.n).toBe(linksBefore?.n);
    expect(await timeline()).toHaveLength(timelineBefore.length);
  }finally{nextCapture=null;}
},120000);

test('不同资料可同时等待远程模型，完成后重复维护不再次识别',async()=>{
  const slugs=['notes/parallel-a','notes/parallel-b'];
  await engine.putPage(slugs[0],{type:'note',title:'隔离资料甲',compiled_truth:'第一份合成资料记录项目甲的安排和验收。'.repeat(3),frontmatter:{}});
  await engine.putPage(slugs[1],{type:'note',title:'隔离资料乙',compiled_truth:'第二份合成资料记录项目乙的进度和交付。'.repeat(3),frontmatter:{}});
  held=true;const before=requests;
  const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs});
  try{
    await waitFor(async()=>releases.size>=2,15000);
    expect(requests-before).toBe(2);
  }finally{held=false;for(const release of releases)release();releases.clear();}
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
  const done=(await runtime.getRun(run.id))!;expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');
  expect((done.result as any).phases.find((phase:any)=>phase.phase==='capture_entities').details.peak_active_chunks).toBe(2);
  const again=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs});
  await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(again.id))!.status));
  expect((await runtime.getRun(again.id))!.status).toBe('completed');expect(requests-before).toBe(2);
},90000);

test('模型设置没有价格时，旧通用价格和任务上限都不阻止原任务完成',async()=>{
  const path=configPath(),saved=readFileSync(path,'utf8'),config=JSON.parse(saved);
  delete config.desktop.model_services[0].models[0].inputPriceCny;delete config.desktop.model_services[0].models[0].outputPriceCny;
  writeFileSync(path,JSON.stringify(config));await engine.setConfig('dream.entity_capture.cost_cap_cny','0.00001');
  try{
    await engine.putPage('notes/unpriced-full-task',{type:'note',title:'未定价隔离资料',compiled_truth:'这是未设置模型单价的资料，验证旧价格不会阻止实体整理。'.repeat(3),frontmatter:{}});
    const before=requests,run=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs:['notes/unpriced-full-task']});
    await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
    const done=(await runtime.getRun(run.id))!;expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');expect(requests-before).toBe(1);
    const result=done.result as any,capture=result.phases.find((phase:any)=>phase.phase==='capture_entities');
    expect(capture.details.cost_cap_cny).toBeNull();expect(result.budget.unpricedCostUnknown).toBe(true);expect(done.product?.detail).toContain('部分模型未设置价格');
  }finally{writeFileSync(path,saved);await engine.setConfig('dream.entity_capture.cost_cap_cny','1000');}
},90000);

test('已定价模型缺少用量时，重试仍保留预留并在提高上限后继续',async()=>{
  const slugs=['notes/unconfirmed-a','notes/unconfirmed-b'];
  await engine.putPage(slugs[0],{type:'note',title:'未确认用量甲',compiled_truth:'第一份合成资料用于验证用量缺失后的预算预留。'.repeat(3),frontmatter:{}});
  await engine.putPage(slugs[1],{type:'note',title:'未确认用量乙',compiled_truth:'第二份合成资料用于验证提高预算后才能继续。'.repeat(3),frontmatter:{}});
  await engine.setConfig('dream.entity_capture.cost_cap_cny','0.14');omitUsage=true;const before=requests;
  try{
    const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs});
    await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
    expect(requests-before).toBe(1);
    const [child]=await engine.executeRaw<{ceiling:string}>("SELECT data->>'capture_cost_ceiling_cny' ceiling FROM minion_jobs WHERE private_queue_owner_job_id=$1 AND data ? 'ingest_context' ORDER BY id LIMIT 1",[Number(run.id.slice(5))]);
    expect(Number(child.ceiling)).toBeCloseTo(0.14,6);
    omitUsage=false;await runtime.retry(run.id);await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));expect(requests-before).toBe(1);
    await engine.setConfig('dream.entity_capture.cost_cap_cny','0.5');await runtime.retry(run.id);await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
    const done=(await runtime.getRun(run.id))!;expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');expect(requests-before).toBe(2);
  }finally{omitUsage=false;await engine.setConfig('dream.entity_capture.cost_cap_cny','1000');}
},90000);

test('模型明确报告零用量时，跨窗口继续不会错误保留预算',async()=>{
  const slugs=Array.from({length:33},(_,index)=>`notes/zero-usage-${index}`);
  for(const slug of slugs)await engine.putPage(slug,{type:'note',title:slug,compiled_truth:`${slug} 用于验证明确报告零用量时跨窗口继续。`.repeat(3),frontmatter:{}});
  await engine.setConfig('dream.entity_capture.cost_cap_cny','0.14');zeroUsage=true;const before=requests;
  try{
    const run=await runtime.submitDream({phase:'capture_entities',sourceId:'default',slugs});
    await waitFor(async()=>['completed','failed'].includes((await runtime.getRun(run.id))!.status));
    const done=(await runtime.getRun(run.id))!;expect(done.status,done.error??JSON.stringify(done.result)).toBe('completed');expect(requests-before).toBe(33);
    const capture=(done.result as any).phases.find((phase:any)=>phase.phase==='capture_entities');
    expect(capture.details.chunks_processed).toBe(33);expect(capture.details.cost_cny).toBe(0);
  }finally{zeroUsage=false;await engine.setConfig('dream.entity_capture.cost_cap_cny','1000');}
},120000);
