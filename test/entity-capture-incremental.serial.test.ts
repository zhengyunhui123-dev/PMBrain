import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import type {BrainEngine} from '../src/core/engine.ts';
import {runPhaseCaptureEntities,type CaptureEntitiesOpts} from '../src/core/cycle/capture-entities.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';
import {finalizeEntityIngest} from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import {annotateIngestContent,activeIngestContent} from '../src/core/pmbrain-adapters/ingest-provenance.ts';
import {parseMarkdown} from '../src/core/markdown.ts';

const previous=process.env.PMBRAIN_HOME;
process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-capture-incremental-'));
const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine:BrainEngine;
beforeAll(async()=>{
  if(url)assertSafeE2eDatabaseUrl(url);
  engine=url?new PostgresEngine():new PGLiteEngine();
  await engine.connect(url?{database_url:url}:{});await engine.initSchema();
  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('version','135');
  await engine.setConfig('pmbrain.schema.version','135');
},60000);
afterAll(async()=>{await engine?.disconnect();if(previous===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=previous;});

test('未变化再次整理不读正文、不调用模型；只改长文尾段时复用成功分块，其他资料保持缓存',async()=>{
  const original=Array.from({length:350},(_,index)=>`第${index}条隔离工作记录，核对今日安排和交付检查项，不包含需要单独建档的名称。`).join('\n');
  for(const [slug,body] of [['notes/long',original],['notes/other','这是另一份保持不变的合成工作记录，核对今天的日常安排和检查清单。'.repeat(3)]]){
    await engine.putPage(slug!,{type:'note',title:slug!,compiled_truth:body!,frontmatter:{}});
  }
  const submissions:Array<{slug:string;body:string}>=[];
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    const ingest=(ctx.data as any).ingest_context;submissions.push({slug:ingest.slug,body:ingest.chunkBody});
    return {ingest_verified:true,ingest_entities:[],result:JSON.stringify({entities:[],relations:[],no_entities:true}),tokens:{in:10,out:5},stop_reason:'end_turn'};
  };
  const options={model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true}};
  const first=await runPhaseCaptureEntities(engine,options);
  expect(first.status,first.summary).toBe('ok');
  const initial=submissions.length;
  const originalRead=engine.getPage;const read=engine.getPage.bind(engine);let bodyReads=0;
  engine.getPage=async function(...args){bodyReads++;return originalRead.apply(this,args);};
  const second=await runPhaseCaptureEntities(engine,options);
  expect(second.details.pages_cached).toBe(2);expect(bodyReads).toBe(0);expect(submissions).toHaveLength(initial);
  const before=await read('notes/long');
  await engine.putPage('notes/long',{...before!,compiled_truth:original+'\n新增一条没有具名实体的核对记录，确认变更后的验收事项。'.repeat(4)});
  const changed=await runPhaseCaptureEntities(engine,options);
  expect(changed.status,changed.summary).toBe('ok');
  expect(changed.details.pages_cached).toBe(1);
  expect(submissions.slice(initial).map(row=>row.slug)).toEqual(['notes/long']);
  expect(submissions.at(-1)!.body.length).toBeLessThan(1000);
  const [checkpoint]=await engine.executeRaw<{valid:boolean}>("SELECT bool_and(jsonb_typeof(result->'capture_proof')='array' AND result->'graph_reconciled'='true'::jsonb) valid FROM minion_jobs WHERE status='completed'");
  expect(checkpoint?.valid).toBe(true);
},120000);

test('一个窗口最多提交一个分块，后续窗口复用凭据直到完成，不重复模型请求',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','133');
  for(let index=0;index<3;index++)await engine.putPage(`notes/window-${index}`,{type:'note',title:`隔离窗口${index}`,compiled_truth:'这是一条没有具名实体的工作核对记录，只包含日常安排与验收事项。'.repeat(3),frontmatter:{}});
  let calls=0;
  const statuses:string[]=[];
  for(let window=0;window<3;window++){
    const result=await runPhaseCaptureEntities(engine,{model:'anthropic:claude-sonnet-4-6',getConcurrency:()=>2,window:{maxChunks:1,maxDurationMs:300000},budget:{costCapCny:null,ollama:true},handler:async()=>{
      calls++;return {ingest_verified:true,ingest_entities:[],result:JSON.stringify({entities:[],relations:[],no_entities:true}),tokens:{in:10,out:5},stop_reason:'end_turn'};
    }});
    statuses.push(String(result.details.stop_reason));expect(result.details.chunks_submitted).toBe(1);
  }
  expect(statuses).toEqual(['window','window','completed']);expect(calls).toBe(3);
  expect((await engine.executeRaw('SELECT id FROM minion_jobs'))).toHaveLength(3);
},120000);

test('快速维护复用相同资料及备份，保留各自来源；不同内容仍识别',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','135');
  const body='张三负责星河项目的交付工作，星河项目由星河公司实施。星河团队负责协调。';
  const duplicateSlugs=['notes/original','notes/backups/copy','notes/backups/copy.bak.md','notes/备份/copy'];
  for(const slug of duplicateSlugs)await engine.putPage(slug,{type:'note',title:slug,compiled_truth:body,frontmatter:{}});
  const submissions:string[]=[];
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    const input=(ctx.data as any).ingest_context;submissions.push(input.slug);
    const entities=[['projects/星河','星河项目','project'],['companies/星河','星河公司','company'],['companies/星河团队','星河团队','organization'],['people/张三','张三','person']];
    if(input.chunkBody.includes('李四'))entities.push(['people/李四','李四','person']);
    for(const [slug,title,type] of entities){
      const content=await annotateIngestContent(engine,input,slug!,`---\ntitle: ${title}\ntype: ${type}\n---\n${title}的来源资料。[Source: ${input.slug}]`);
      await engine.putPage(slug!,parseMarkdown(content,slug!),{sourceId:input.sourceId});
    }
    const result=JSON.stringify({entities:entities.map(row=>row[0]),relations:[{from:'projects/星河',to:'companies/星河',link_type:'mentions',evidence:'星河项目由星河公司实施。'}]});
    const verified=await finalizeEntityIngest(engine,input,result);
    return {ingest_verified:true,ingest_entities:verified.entities,result,tokens:{in:10,out:5},stop_reason:'end_turn'};
  };
  const options={sourceId:'default',quickEntitiesOnly:true,getConcurrency:()=>2,model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true}};
  await runPhaseCaptureEntities(engine,options);
  expect(submissions).toHaveLength(1);
  const links=await engine.executeRaw<{slug:string}>(`SELECT DISTINCT s.slug FROM links l JOIN pages s ON s.id=l.from_page_id JOIN pages e ON e.id=l.to_page_id WHERE e.slug='projects/星河' AND s.slug=ANY($1::text[])`,[duplicateSlugs]);
  expect(links.map(row=>row.slug).sort()).toEqual([...duplicateSlugs].sort());
  const entity=(await engine.getPage('projects/星河'))!;
  const provenance=entity.frontmatter.pmbrain_ingest_provenance as Array<{slug:string}>;
  expect(provenance.map(row=>row.slug).sort()).toEqual([...duplicateSlugs].sort());
  expect((await activeIngestContent(engine,entity)).origins).toHaveLength(4);
  const relations=await engine.executeRaw("SELECT id FROM links WHERE link_type='mentions' AND origin_page_id IN (SELECT id FROM pages WHERE slug=ANY($1::text[])) AND from_page_id=(SELECT id FROM pages WHERE slug='projects/星河') AND to_page_id=(SELECT id FROM pages WHERE slug='companies/星河')",[duplicateSlugs]);
  expect(relations).toHaveLength(4);
  await runPhaseCaptureEntities(engine,options);expect(submissions).toHaveLength(1);
  await runPhaseCaptureEntities(engine,{...options,model:'anthropic:claude-haiku-4-5'});expect(submissions).toHaveLength(1);
  await engine.putPage('notes/备份/new',{type:'note',title:'不同内容的备份',compiled_truth:body+' 李四担任验收负责人。',frontmatter:{}});
  await runPhaseCaptureEntities(engine,options);expect(submissions).toHaveLength(2);
  expect((await engine.getPage('people/李四'))?.type).toBe('person');
},120000);

test('快速维护沿用旧版成功凭据，仅关联其中四类实体',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','135');
  const body='张三负责星河项目并使用敏捷方法。';
  await engine.putPage('notes/legacy-original',{type:'note',title:'旧资料',compiled_truth:body,frontmatter:{}});
  let calls=0;
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    calls++;const input=(ctx.data as any).ingest_context;
    for(const [slug,title,type] of [['people/张三','张三','person'],['projects/星河','星河项目','project'],['concepts/敏捷','敏捷方法','concept']]){
      const content=await annotateIngestContent(engine,input,slug!,`---\ntitle: ${title}\ntype: ${type}\n---\n${title}的记录。[Source: ${input.slug}]`);
      await engine.putPage(slug!,parseMarkdown(content,slug!),{sourceId:input.sourceId});
    }
    const result=JSON.stringify({entities:['people/张三','projects/星河','concepts/敏捷'],relations:[]});
    const verified=await finalizeEntityIngest(engine,input,result);
    return {ingest_verified:true,ingest_entities:verified.entities,result,tokens:{in:10,out:5},stop_reason:'end_turn'};
  };
  const options={sourceId:'default',model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true}};
  await runPhaseCaptureEntities(engine,options);expect(calls).toBe(1);
  await engine.putPage('notes/备份/legacy-copy',{type:'note',title:'旧资料备份',compiled_truth:body,frontmatter:{}});
  await runPhaseCaptureEntities(engine,{...options,quickEntitiesOnly:true});expect(calls).toBe(1);
  const links=await engine.executeRaw<{slug:string}>(`SELECT DISTINCT p.slug FROM links l JOIN pages s ON s.id=l.from_page_id JOIN pages p ON p.id=l.to_page_id WHERE s.slug='notes/备份/legacy-copy' AND p.slug=ANY($1::text[])`,[['people/张三','projects/星河','concepts/敏捷']]);
  expect(links.map(row=>row.slug).sort()).toEqual(['people/张三','projects/星河'].sort());
},120000);

test('长资料中断后继续复用分块，相同内容跨 Source 不混用',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','135');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('scope-a','测试甲'),('scope-b','测试乙') ON CONFLICT DO NOTHING");
  const body=Array.from({length:650},(_,index)=>`第${index}条工作安排记录，核对当天事项和进度。`).join('\n');
  for(const slug of ['notes/original','notes/备份/copy'])await engine.putPage(slug,{type:'note',title:slug,compiled_truth:body,frontmatter:{}},{sourceId:'scope-a'});
  await engine.putPage('notes/other',{type:'note',title:'其他来源',compiled_truth:body,frontmatter:{}},{sourceId:'scope-b'});
  const submissions:Array<{sourceId:string;body:string}>=[];
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    const input=(ctx.data as any).ingest_context;submissions.push({sourceId:input.sourceId,body:input.chunkBody});
    return {ingest_verified:true,ingest_entities:[],result:JSON.stringify({entities:[],relations:[],no_entities:true}),tokens:{in:1,out:1},stop_reason:'end_turn'};
  };
  const options={sourceId:'scope-a',quickEntitiesOnly:true,model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true},window:{maxChunks:1,maxDurationMs:300000}};
  let result=await runPhaseCaptureEntities(engine,options);
  expect(result.details.stop_reason).toBe('window');
  for(let i=0;i<10&&Number(result.details.pages_remaining)>0;i++)result=await runPhaseCaptureEntities(engine,options);
  expect(result.details.pages_remaining).toBe(0);
  const sourceA=submissions.filter(row=>row.sourceId==='scope-a');
  expect(sourceA.length).toBeGreaterThan(1);
  expect(new Set(sourceA.map(row=>row.body)).size).toBe(sourceA.length);
  await runPhaseCaptureEntities(engine,{...options,sourceId:'scope-b',window:undefined});
  expect(submissions.filter(row=>row.sourceId==='scope-b')).toHaveLength(sourceA.length);
},120000);

test('其他资料的一处未关联提及不影响已完成资料的凭据',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','135');
  await engine.putPage('notes/mention-only',{type:'note',title:'仅提及',compiled_truth:'赵敏出现在这份简单的工作记录中。',frontmatter:{}});
  await engine.putPage('notes/person-detail',{type:'note',title:'人物资料',compiled_truth:'赵敏负责实际的工作交付和验收。',frontmatter:{}});
  let calls=0;
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    calls++;const input=(ctx.data as any).ingest_context;
    if(input.slug==='notes/mention-only')return {ingest_verified:true,ingest_entities:[],result:JSON.stringify({entities:[],relations:[],no_entities:true}),tokens:{in:1,out:1},stop_reason:'end_turn'};
    const content=await annotateIngestContent(engine,input,'people/赵敏',`---\ntitle: 赵敏\ntype: person\n---\n赵敏负责交付。[Source: ${input.slug}]`);
    await engine.putPage('people/赵敏',parseMarkdown(content,'people/赵敏'));
    const result=JSON.stringify({entities:['people/赵敏'],relations:[]});
    const verified=await finalizeEntityIngest(engine,input,result);
    return {ingest_verified:true,ingest_entities:verified.entities,result,tokens:{in:1,out:1},stop_reason:'end_turn'};
  };
  const execute=engine.executeRaw;let removed=false;
  engine.executeRaw=async function<T=Record<string,unknown>>(sql:string,params?:unknown[],opts?:{signal?:AbortSignal}):Promise<T[]>{
    if(!removed&&sql.includes('SELECT f.slug from_slug')){
      removed=true;
      await execute.call(this,`DELETE FROM links WHERE (from_page_id=(SELECT id FROM pages WHERE slug='notes/mention-only') AND to_page_id=(SELECT id FROM pages WHERE slug='people/赵敏')) OR (to_page_id=(SELECT id FROM pages WHERE slug='notes/mention-only') AND from_page_id=(SELECT id FROM pages WHERE slug='people/赵敏'))`);
    }
    return await execute.call(this,sql,params,opts) as T[];
  };
  const options={sourceId:'default',quickEntitiesOnly:true,model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true}};
  try{
    const first=await runPhaseCaptureEntities(engine,options);expect(first.details.unlinked_mentions).toBeGreaterThan(0);
    expect(calls).toBe(2);
    const again=await runPhaseCaptureEntities(engine,options);expect(again.details.pages_cached).toBe(2);expect(calls).toBe(2);
  }finally{engine.executeRaw=execute;}
},120000);

test('快速维护停止后继续，相同备份复用已写入实体和来源关系',async()=>{
  await resetPgliteState(engine as PGLiteEngine);await engine.setConfig('version','135');
  const body='晨星项目已完成第一阶段验收。';
  for(const slug of ['notes/stop-original','notes/备份/stop-copy'])await engine.putPage(slug,{type:'note',title:slug,compiled_truth:body,frontmatter:{}});
  const controller=new AbortController();let calls=0;
  const handler:NonNullable<CaptureEntitiesOpts['handler']>=async ctx=>{
    calls++;const input=(ctx.data as any).ingest_context;
    const content=await annotateIngestContent(engine,input,'projects/晨星',`---\ntitle: 晨星项目\ntype: project\n---\n晨星项目完成验收。[Source: ${input.slug}]`);
    await engine.putPage('projects/晨星',parseMarkdown(content,'projects/晨星'));
    const result=JSON.stringify({entities:['projects/晨星'],relations:[]});
    const verified=await finalizeEntityIngest(engine,input,result);
    return {ingest_verified:true,ingest_entities:verified.entities,result,tokens:{in:1,out:1},stop_reason:'end_turn'};
  };
  const options={sourceId:'default',quickEntitiesOnly:true,getConcurrency:()=>2,model:'anthropic:claude-sonnet-4-6',handler,budget:{costCapCny:null,ollama:true}};
  const stopped=await runPhaseCaptureEntities(engine,{...options,signal:controller.signal,onProgress:progress=>{if(progress.unit==='分块'&&progress.done>=1)controller.abort(new Error('user_stop'));}});
  expect(stopped.details.stop_reason).not.toBe('completed');expect(calls).toBe(1);
  const resumed=await runPhaseCaptureEntities(engine,options);
  expect(resumed.details.pages_remaining).toBe(0);expect(calls).toBe(1);
  const entities=await engine.executeRaw("SELECT id FROM pages WHERE type='project' AND title='晨星项目'");expect(entities).toHaveLength(1);
  const links=await engine.executeRaw("SELECT l.id FROM links l JOIN pages s ON s.id=l.from_page_id JOIN pages e ON e.id=l.to_page_id WHERE s.slug=ANY($1::text[]) AND e.slug='projects/晨星'",[['notes/stop-original','notes/备份/stop-copy']]);
  expect(links.length).toBeGreaterThanOrEqual(2);
},120000);
