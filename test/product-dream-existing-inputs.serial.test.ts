import {afterAll,afterEach,beforeAll,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import type {BrainEngine} from '../src/core/engine';
import {ProductTaskRuntime} from '../src/product/tasks/runtime';
import {importFromContent} from '../src/core/import-file';
import {configPath} from '../src/core/config';
import {initializeSourceGit,commitSourceGit} from '../src/core/source-git';
import {resetPgliteState} from './helpers/reset-pglite';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';

const envKeys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const databaseUrl=process.env.PMBRAIN_DREAM_TEST_POSTGRES==='1'?process.env.DATABASE_URL:undefined;
let engine:BrainEngine,runtime:ProductTaskRuntime,root:string,sourceRoot:string;
let modelServer:ReturnType<typeof Bun.serve>;
let extractionCalls=0,conceptCalls=0,unsupported=false;
const quote='每次发布前必须保存原始证据，再由另一位评审者核验来源，完成后才能宣布验收通过。';
const body=(label:string)=>`# ${label}\n\n${quote}\n\n`+'测试项目采用证据驱动发布，资料原文与人工结论要保留，任务恢复只处理尚未完成的部分。'.repeat(18);

beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-existing-dream-'));
  for(const key of envKeys)delete process.env[key];
  process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  mkdirSync(join(root,'.pmbrain'));
  sourceRoot=join(root,'sources');mkdirSync(sourceRoot);mkdirSync(join(sourceRoot,'notes'));
  initializeSourceGit(sourceRoot);writeFileSync(join(sourceRoot,'README.md'),'# 隔离验收');commitSourceGit(sourceRoot,'isolated initial source');
  modelServer=Bun.serve({port:0,async fetch(req){
    const request=await req.json() as any;
    const messages=JSON.stringify(request.messages);
    let content:string;
    if(messages.includes('<source_data>')){
      extractionCalls++;
      content=JSON.stringify([{title:`知识证据${extractionCalls}`,atom_type:'insight',body:quote,source_quote:unsupported?'这句话并不存在于原始资料中。':quote,concepts:['证据驱动发布']}]);
    }else{conceptCalls++;content='发布前保存原始证据，并由另一位评审者核验来源；失败后只继续未完成内容。';}
    return Response.json({id:'isolated-dream',object:'chat.completion',model:'mimo-v2.6-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}});
  }});
  writeFileSync(configPath(),JSON.stringify({engine:databaseUrl?'postgres':'pglite',database_path:join(root,'database'),schema_pack:'gbrain-base-v2',chat_model:'mimo:mimo-v2.6-flash',models:{default:'mimo:mimo-v2.6-flash'},mimo_api_key:'isolated-test-only',provider_base_urls:{mimo:modelServer.url.origin+'/v1'},embedding_disabled:true,memory:{auto_writeback:'off'},desktop:{knowledge_directory:sourceRoot}}));
  if(databaseUrl)assertSafeE2eDatabaseUrl(databaseUrl);
  engine=databaseUrl?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(databaseUrl?{database_url:databaseUrl}:{database_path:join(root,'database')});await engine.initSchema();
},90_000);

beforeEach(async()=>{
  await resetPgliteState(engine as any);extractionCalls=0;conceptCalls=0;unsupported=false;
  await engine.setConfig('version','135');await engine.setConfig('pmbrain.schema.version','135');
  await engine.executeRaw("UPDATE sources SET local_path=$1,config=config-'remote_url' WHERE id='default'",[sourceRoot]);
  for(const [key,value]of Object.entries({'dream.knowledge.enabled':'true','dream.knowledge.since':'2026-10-20T09:28:19.328Z','dream.knowledge.use_ordinary_model':'true','dream.synthesize.conversation_pages':'true','dream.synthesize.enabled':'true','dream.synthesize.dual_write':'false','dream.entity_capture.enabled':'false','sync.auto_git_commit':'false','sync.include_working_tree':'true','sync.repo_path':sourceRoot,'models.default':'mimo:mimo-v2.6-flash'}))await engine.setConfig(key,value);
  runtime=new ProductTaskRuntime(engine);await runtime.start();
},60_000);
afterEach(async()=>{await runtime?.close();},60_000);
afterAll(async()=>{
  await engine?.disconnect();modelServer?.stop(true);
  for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  if(root)rmSync(root,{recursive:true,force:true});
},60_000);

async function run(){
  const submitted=await runtime.submitDream({preset:'full',sourceId:'default'});
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline){const task=await runtime.getRun(submitted.id);if(task&&!['queued','running'].includes(task.status))return task;await Bun.sleep(40);}
  throw new Error(`Existing-input task did not finish: ${JSON.stringify(await runtime.getRun(submitted.id))}`);
}
const phase=(run:any,name:string)=>run.result?.phases.find((row:any)=>row.phase===name);

test('enabling deep organization processes already imported notes, reuses them, and extracts only a changed note',async()=>{
  for(let index=0;index<5;index++)await importFromContent(engine,`notes/old-${index}`,body(`旧资料${index}`),{noEmbed:true,sourceId:'default'});
  await engine.executeRaw("UPDATE pages SET updated_at='2026-10-19T02:00:00Z' WHERE type='note'");
  const original=await engine.getPage('notes/old-0');
  const first=await run();
  expect(first.status).toBe('completed');
  expect(phase(first,'extract_atoms')?.details.pages_processed).toBe(5);
  expect(phase(first,'extract_atoms')?.details.atoms_extracted).toBe(5);
  expect(phase(first,'synthesize_concepts')?.details.concepts_llm).toBeGreaterThan(0);
  expect((await engine.getPage('notes/old-0'))?.compiled_truth).toBe(original?.compiled_truth);
  const [counts]=await engine.executeRaw<{atoms:number;links:number;chunks:number}>("SELECT (SELECT count(*)::int FROM pages WHERE type='atom') atoms,(SELECT count(*)::int FROM links) links,(SELECT count(*)::int FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.type='atom') chunks");
  expect(counts.atoms).toBe(5);expect(counts.links).toBeGreaterThanOrEqual(10);expect(counts.chunks).toBeGreaterThanOrEqual(5);
  const before=[extractionCalls,conceptCalls];
  const second=await run();expect(phase(second,'extract_atoms')?.details.pages_total).toBe(0);expect([extractionCalls,conceptCalls]).toEqual(before);
  await importFromContent(engine,'notes/old-0',body('旧资料0')+'\n补充决定：验收回执必须记录资料版本。',{noEmbed:true,sourceId:'default'});
  const changed=await run();expect(phase(changed,'extract_atoms')?.details.pages_processed).toBe(1);expect(extractionCalls).toBe(before[0]+1);
  expect(await engine.getConfig('dream.knowledge.since')).toBe('2026-10-20T09:28:19.328Z');
},90_000);

test('pending historical notes are not hidden by a newly synchronized file and invalid quotes stay pending',async()=>{
  await importFromContent(engine,'notes/pending',body('历史待处理'),{noEmbed:true,sourceId:'default'});
  await engine.executeRaw("UPDATE pages SET updated_at='2026-10-19T02:00:00Z' WHERE slug='notes/pending'");
  writeFileSync(join(sourceRoot,'notes','new.md'),body('新同步资料'));
  const mixed=await run();expect(phase(mixed,'extract_atoms')?.details.pages_processed).toBe(2);
  unsupported=true;
  await importFromContent(engine,'notes/invalid-evidence',body('原文证据保护'),{noEmbed:true,sourceId:'default'});
  const invalid=await run();const extraction=phase(invalid,'extract_atoms');
  expect(extraction?.details.failures.some((row:any)=>row.error.includes('atom_evidence_unverified'))).toBe(true);
  expect(extraction?.details.pages_remaining).toBe(1);
  expect((await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM pages WHERE type='atom' AND frontmatter->>'source_slug'='notes/invalid-evidence'"))[0].n).toBe(0);
},90_000);
