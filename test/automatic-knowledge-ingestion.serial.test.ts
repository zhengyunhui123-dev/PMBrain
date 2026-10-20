import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import type {BrainEngine} from '../src/core/engine.ts';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import {ProductTaskRuntime} from '../src/product/tasks/runtime.ts';
import {configPath} from '../src/core/config.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {importFile} from '../src/core/import-file.ts';
import {resetPgliteState} from './helpers/reset-pglite.ts';

let root:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>;
let calls=0,embeddingCalls=0,invalid=false;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;

async function finished(id:string){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){const run=await runtime.getRun(id);if(run&&!['queued','running'].includes(run.status))return run;await Bun.sleep(40);}
  throw new Error(JSON.stringify(await runtime.getRun(id)));
}

beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-auto-knowledge-'));
  for(const key of keys)delete process.env[key];
  process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;mkdirSync(join(root,'.pmbrain'));
  const dimensions=database?1536:1024;
  server=Bun.serve({port:0,async fetch(request){
    const body=await request.json() as {input?:unknown[];messages?:unknown[];tools?:Array<{function:{name:string}}>};
    if(new URL(request.url).pathname.endsWith('/embeddings')){embeddingCalls++;return Response.json({object:'list',data:(Array.isArray(body.input)?body.input:[body.input]).map((_,index)=>({object:'embedding',index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'isolated-embedding',usage:{prompt_tokens:2,total_tokens:2}});}
    calls++;
    const prompt=JSON.stringify(body.messages),source=prompt.match(/Source: ([a-z0-9-]+)/)?.[1]??'knowledge-auto';
    const slug=prompt.match(/资料 slug: ([^\\\s]+)/)?.[1]??'first';
    const fact=prompt.includes('刘慈欣参与了科幻讨论')?'刘慈欣参与了科幻讨论。':'刘慈欣创作了三体。';
    const content=`---\ntitle: 刘慈欣\ntype: person\n---\n${fact} [Source: ${slug}] [[${source}:${slug}]]`;
    const tool=body.tools?.find(tool=>tool.function.name.endsWith('capture_entities'))?.function.name??'brain_capture_entities';
    return Response.json({id:`capture-${calls}`,object:'chat.completion',created:1,model:'isolated-capture',choices:[{index:0,finish_reason:invalid?'stop':'tool_calls',message:invalid?{role:'assistant',content:'{"entities":[],"relations":[]}'}:{role:'assistant',content:null,tool_calls:[{id:`capture-${calls}`,type:'function',function:{name:tool,arguments:JSON.stringify({entities:[{slug:'people/liu',content}],relations:[]})}}]}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
  }});
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',custom_openai_api_key:'isolated-only',embedding_model:'custom-openai:isolated-embedding',embedding_dimensions:dimensions,provider_base_urls:{'custom-openai':server.url.origin+'/v1'},models:{default:'custom-openai:isolated-capture'},model_usage:{generative_enabled:true,embedding_enabled:true},desktop:{knowledge_directory:root}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  engine=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database?{database_url:database}:{});await engine.initSchema();
  await resetPgliteState(engine as any);await engine.setConfig('version','135');await engine.setConfig('pmbrain.schema.version','135');
  for(const source of ['knowledge-auto','knowledge-other']){
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1',[source]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT(id) DO NOTHING',[source]);
  }
  runtime=new ProductTaskRuntime(engine);await runtime.start();
},60000);

test('new source material synchronized by quick maintenance is captured in that task and unchanged vectors are reused',async()=>{
  const directory=join(root,'sync-source');mkdirSync(directory);
  writeFileSync(join(directory,'synced.md'),'# 同步资料\n\n刘慈欣创作了三体。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('knowledge-sync','同步验收',$1) ON CONFLICT(id) DO UPDATE SET local_path=EXCLUDED.local_path",[directory]);
  const run=await runtime.submitDream({preset:'quick',sourceId:'knowledge-sync'}),done=await finished(run.id);
  expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect(await engine.getPage('people/liu',{sourceId:'knowledge-sync'})).not.toBeNull();
  expect((await engine.getChunks('people/liu',{sourceId:'knowledge-sync'})).every(chunk=>!!chunk.embedded_at)).toBe(true);
  const count=calls,vectors=embeddingCalls;
  expect((await finished((await runtime.submitDream({preset:'quick',sourceId:'knowledge-sync'})).id)).status).toBe('completed');
  expect(calls).toBe(count);expect(embeddingCalls).toBe(vectors);
},60000);

test('automatic ingestion setting preserves pending original material; maintenance resumes after enabling',async()=>{
  await engine.setConfig('dream.entity_capture.enabled','false');
  const file=join(root,'disabled.md');writeFileSync(file,'# 暂停实体整理\n\n刘慈欣参与了科幻讨论。');
  const count=calls;
  const done=await finished((await runtime.submitImport({path:file,sourceId:'knowledge-other',noEmbed:true})).id);
  expect(done.status).toBe('completed');expect((done.result as {knowledgeStatus:string})?.knowledgeStatus).toBe('disabled');expect(calls).toBe(count);
  expect(await engine.getConfig('dream.entity_capture.pending.knowledge-other')).toContain('disabled');
  await engine.setConfig('dream.entity_capture.enabled','true');
  expect((await finished((await runtime.submitDream({preset:'quick',sourceId:'knowledge-other'})).id)).status).toBe('completed');
  expect(calls).toBeGreaterThan(count);expect(await engine.getConfig('dream.entity_capture.pending.knowledge-other')).toBeNull();
},60000);

test('direct core import survives runtime restart and generated output does not recursively ingest',async()=>{
  await runtime.close();
  const file=join(root,'direct.md');writeFileSync(file,'# 直接导入\n\n刘慈欣创作了三体。');
  await importFile(engine,file,'direct.md',{sourceId:'knowledge-auto',noEmbed:true});
  writeFileSync(file,'# 自动备份\n\n刘慈欣参与了科幻讨论。这是生成的备份副本。');
  await importFile(engine,file,'output/agent-notes/copy.md',{sourceId:'knowledge-auto',noEmbed:true});
  const pending=JSON.parse((await engine.getConfig('dream.entity_capture.pending.knowledge-auto'))!);
  expect(pending.slugs).toEqual(['direct']);
  runtime=new ProductTaskRuntime(engine);await runtime.start();
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){if((await runtime.listRuns()).some(run=>run.kind==='dream_capture_entities'&&run.trigger==='scheduled'&&run.status==='completed'))break;await Bun.sleep(50);}
  expect(await engine.getConfig('dream.entity_capture.pending.knowledge-auto')).toBeNull();
  expect((await engine.getPage('people/liu',{sourceId:'knowledge-auto'}))?.compiled_truth).toContain('[Source: direct]');
},60000);

test('ordinary import embeds the new entity and appending to the same file updates its evidence once',async()=>{
  const file=join(root,'append.md');writeFileSync(file,'# 追加资料\n\n刘慈欣创作了三体。');
  const first=await finished((await runtime.submitImport({path:file,sourceId:'knowledge-other'})).id);
  expect(first.status,JSON.stringify(first.result)).toBe('completed');
  const chunks=await engine.getChunks('people/liu',{sourceId:'knowledge-other'});expect(chunks.length).toBeGreaterThan(0);expect(chunks.every(chunk=>!!chunk.embedded_at)).toBe(true);
  const count=calls;writeFileSync(file,'# 追加资料\n\n刘慈欣创作了三体。\n\n刘慈欣参与了科幻讨论。');
  expect((await finished((await runtime.submitImport({path:file,sourceId:'knowledge-other'})).id)).status).toBe('completed');expect(calls).toBe(count+1);
  const entity=await engine.getPage('people/liu',{sourceId:'knowledge-other'});expect(entity?.compiled_truth).toContain('创作了三体');expect(entity?.compiled_truth).toContain('参与了科幻讨论');
  const vectors=embeddingCalls,after=calls;
  expect((await finished((await runtime.submitImport({path:file,sourceId:'knowledge-other'})).id)).status).toBe('completed');expect(calls).toBe(after);expect(embeddingCalls).toBe(vectors);
},60000);

afterAll(async()=>{
  await runtime?.close();await engine?.disconnect();server?.stop(true);
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  if(root&&resolve(root).startsWith(resolve(tmpdir())+sep)&&root.includes('pmbrain-auto-knowledge-'))rmSync(root,{recursive:true,force:true});
},60000);

test('import automatically creates an evidenced entity and source graph within the same task',async()=>{
  const file=join(root,'first.md');writeFileSync(file,'# 科幻资料\n\n刘慈欣创作了三体。');
  const run=await runtime.submitImport({path:file,sourceId:'knowledge-auto',noEmbed:true});
  const done=await finished(run.id);expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect((await engine.getPage('people/liu',{sourceId:'knowledge-auto'}))?.compiled_truth).toContain('创作了三体');
  expect((done.result as {phases:Array<{phase:string}>}).phases.some(phase=>phase.phase==='capture_entities')).toBe(true);
  const edges=await engine.executeRaw<{from_slug:string;to_slug:string}>('SELECT f.slug from_slug,t.slug to_slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1',['knowledge-auto']);
  expect(edges).toContainEqual({from_slug:'first',to_slug:'people/liu'});
  expect(edges).toContainEqual({from_slug:'people/liu',to_slug:'first'});
  expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE queue='pmbrain-product' AND data->>'kind'='dream_capture_entities' AND data->'task'->'input'->'slugs' ? 'first'")).toHaveLength(0);
},60000);

test('unchanged import and maintenance reuse receipts; new evidence updates the same entity without losing facts',async()=>{
  const count=calls;
  const again=await runtime.submitImport({path:join(root,'first.md'),sourceId:'knowledge-auto',noEmbed:true});expect((await finished(again.id)).status).toBe('completed');expect(calls).toBe(count);
  const file=join(root,'second.md');writeFileSync(file,'# 新增资料\n\n刘慈欣参与了科幻讨论。');
  expect((await finished((await runtime.submitImport({path:file,sourceId:'knowledge-auto',noEmbed:true})).id)).status).toBe('completed');
  const entity=await engine.getPage('people/liu',{sourceId:'knowledge-auto'});
  expect(entity?.compiled_truth).toContain('创作了三体');expect(entity?.compiled_truth).toContain('参与了科幻讨论');
  const after=calls;
  expect((await finished((await runtime.submitDream({preset:'quick',sourceId:'knowledge-auto'})).id)).status).toBe('completed');expect(calls).toBe(after);
},60000);

test('invalid ingestion leaves raw material and live database available; retry uses the original task',async()=>{
  invalid=true;
  const file=join(root,'retry.md');writeFileSync(file,'# 重试资料\n\n刘慈欣参与了科幻讨论。');
  const run=await runtime.submitImport({path:file,sourceId:'knowledge-other',noEmbed:true}),failed=await finished(run.id);
  expect(failed.status).toBe('failed');expect(await engine.getPage('retry',{sourceId:'knowledge-other'})).not.toBeNull();expect((await engine.executeRaw('SELECT 1 AS alive'))[0].alive).toBe(1);
  invalid=false;expect((await runtime.retry(run.id))?.id).toBe(run.id);expect((await finished(run.id)).status).toBe('completed');
  expect((await engine.getPage('people/liu',{sourceId:'knowledge-other'}))?.compiled_truth).toContain('参与了科幻讨论');
  expect((await engine.getPage('people/liu',{sourceId:'knowledge-auto'}))?.compiled_truth).toContain('创作了三体');
},60000);

test('retrying a partially failed directory also ingests the earlier successful files in the original task',async()=>{
  const directory=join(root,'partial-directory');mkdirSync(directory);
  const bad=join(directory,'a-bad.md');writeFileSync(bad,Buffer.alloc(26*1024*1024,'x'));
  writeFileSync(join(directory,'z-good.md'),'# 成功资料\n\n刘慈欣创作了三体。这是独立目录恢复记录，编号 A-155-RESUME。');
  const run=await runtime.submitImport({path:directory,sourceId:'knowledge-other',noEmbed:true});
  const initial=await finished(run.id);expect(initial.status,JSON.stringify(initial.result)).toBe('failed');
  expect(await engine.getConfig('dream.entity_capture.pending.knowledge-other')).toContain('z-good');
  writeFileSync(bad,'# 修复资料\n\n刘慈欣参与了科幻讨论。这是独立目录恢复记录，编号 B-155-RESUME。');
  const count=calls;expect((await runtime.retry(run.id))?.id).toBe(run.id);
  const done=await finished(run.id);expect(done.status,JSON.stringify(done.result)).toBe('completed');expect(calls).toBe(count+2);
  expect(await engine.getConfig('dream.entity_capture.pending.knowledge-other')).toBeNull();
  expect((await engine.getPage('people/liu',{sourceId:'knowledge-other'}))?.compiled_truth).toContain('[Source: z-good]');
},90000);
