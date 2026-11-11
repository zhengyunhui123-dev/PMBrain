import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,utimesSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {ProductTaskRuntime} from '../src/product/tasks/runtime';
import {configPath} from '../src/core/config';
import {reloadLiveGateway} from '../src/core/ai/reload-live-gateway';
import {resetGateway} from '../src/core/ai/gateway';
import {pauseSearchOptimize,loadSearchOptimize} from '../src/product/tasks/search-optimize-store';
import {PostgresEngine} from '../src/core/postgres-engine';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';
import {syncFileManifestKey} from '../src/product/tasks/sync-file-queue';
import {resetPgliteState} from './helpers/reset-pglite';

let root:string,directory:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>,calls=0;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL; const dimensions=database?1536:1024; let cpu=0.95;
let onEmbedding:(()=>Promise<void>)|undefined;
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-process-audit-'));directory=join(root,'materials');mkdirSync(directory);mkdirSync(join(root,'.pmbrain'));
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const body=await request.json() as {input:string|string[]};
    if(!new URL(request.url).pathname.endsWith('/embeddings'))return Response.json({id:'fixture-chat',choices:[{message:{role:'assistant',content:'无新增内容'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
    calls++;
    if(onEmbedding){const action=onEmbedding;onEmbedding=undefined;await action();}
    const inputs=Array.isArray(body.input)?body.input:[body.input];
    return Response.json({data:inputs.map((_,index)=>({index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'audit-test',usage:{prompt_tokens:inputs.length,total_tokens:inputs.length}});
  }});
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',...(database?{database_url:database}:{database_path:join(root,'database')}),embedding_model:'custom-openai:audit-test',embedding_dimensions:dimensions,custom_openai_api_key:'isolated-only',provider_base_urls:{'custom-openai':server.url.origin+'/v1'},models:{default:'custom-openai:audit-test'},model_usage:{embedding_enabled:true,generative_enabled:true},desktop:{knowledge_directory:root}}));
  engine=(database?new PostgresEngine():new WorkerPgliteEngine()) as unknown as BrainEngine;if(database)assertSafeE2eDatabaseUrl(database);await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();
  if(database){const version=await engine.getConfig('version');await resetPgliteState(engine as any);if(version)await engine.setConfig('version',version);}
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[directory]);await engine.setConfig('dream.entity_capture.enabled','false');
  await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:audit-test':{input:1,output:0}}));
  await engine.setConfig('dream.knowledge.enabled','false');await engine.setConfig('dream.synthesize.enabled','false');await engine.setConfig('cycle.enrich_thin.enabled','false');
  await reloadLiveGateway(engine);
  runtime=new ProductTaskRuntime(engine,{background:{sample:()=>({cpuBusyRatio:cpu,bytes:1024**3,availableBytes:12*1024**3,totalBytes:16*1024**3,systemIdleSeconds:0})}});await runtime.start();
},90000);
afterAll(async()=>{
  await runtime?.close();await engine?.disconnect();server?.stop(true);resetGateway();
  for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-process-audit-'))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}

},60000);
async function document(path:string,text:string){const zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);writeFileSync(path,await zip.generateAsync({type:'uint8array'}));}
async function finish(id:string){const end=Date.now()+120000;while(Date.now()<end){const run=await runtime.getRun(id);if(run&&!['running','queued'].includes(run.status))return run;await Bun.sleep(60);}throw new Error('audit task timeout: '+id);}
async function quick(){const run=await runtime.submitDream({preset:'quick',sourceId:'default'},'scheduled');const done=await finish(run.id);expect(done.status,JSON.stringify(done.result)).toBe('completed');return done;}
async function embeddingEnabled(enabled:boolean){const config=JSON.parse(readFileSync(configPath(),'utf8'));config.embedding_disabled=!enabled;config.model_usage.embedding_enabled=enabled;writeFileSync(configPath(),JSON.stringify(config));await reloadLiveGateway(engine);}
async function waitUntil(read:()=>Promise<boolean>,label:string){const end=Date.now()+180000;while(Date.now()<end){if(await read())return;await Bun.sleep(100);}throw new Error(label);}
async function pageEmbedded(slug:string,sourceId='default'){const rows=await engine.getChunks(slug,{sourceId});return rows.length>0&&rows.every(chunk=>!!chunk.embedded_at);}
async function pendingOptimize(sourceId:string,slug:string){const rows=await engine.executeRaw<{value:string}>("SELECT value FROM config WHERE key LIKE 'pmbrain.search_optimize.pending.%'");return rows.map(row=>JSON.parse(row.value) as {sourceId?:string;slug?:string}).filter(item=>item.sourceId===sourceId&&item.slug===slug);}

test('深度整理无文件增量时先提交新概念，解除向量暂停后再补齐搜索索引', async () => {
  const sourceId = 'deep-concept-vector';
  const folder = join(root, sourceId);
  mkdirSync(folder);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, folder]);
  const previousKnowledge = await engine.getConfig('dream.knowledge.enabled');
  const previousPaused = (await loadSearchOptimize(engine)).paused;
  const previousCpu = cpu;
  await engine.setConfig('dream.knowledge.enabled', 'true');
  await embeddingEnabled(true);
  await pauseSearchOptimize(engine, true);
  try {
    for (const label of ['alpha', 'beta']) {
      await engine.putPage(`atoms/${label}`, {
        title: label, type: 'atom', compiled_truth: `Independent evidence for the staged concept ${label}.`, frontmatter: { concepts: ['staged-vector'] },
      }, { sourceId });
    }
    const before = calls;
    const task = await runtime.submitDream({ preset: 'full', sourceId });
    const completed = await finish(task.id);
    expect(completed.status, JSON.stringify(completed.result)).toBe('completed');
    expect(completed.product?.deep?.scan.incremental ?? 0).toBe(0);
    expect(calls).toBe(before);
    const scope = { sourceId };
    const slug = 'concepts/staged-vector';
    const chunks = await engine.getChunks(slug, scope);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(chunk => !chunk.embedded_at)).toBe(true);
    expect((await engine.getLinks(slug, scope)).some(link => link.link_type === 'derives_from')).toBe(true);
    cpu = 0.1;
    await pauseSearchOptimize(engine, false);
    await waitUntil(async () => {
      const rows = await engine.getChunks(slug, scope);
      return rows.length > 0 && rows.every(chunk => !!chunk.embedded_at);
    }, '解除暂停后没有补齐概念向量');
    expect(calls).toBeGreaterThan(before);
  } finally {
    if (previousKnowledge === null) await engine.unsetConfig('dream.knowledge.enabled');
    else await engine.setConfig('dream.knowledge.enabled', previousKnowledge);
    await pauseSearchOptimize(engine, previousPaused);
    cpu = previousCpu;
  }
}, 240000);

test('快速维护按内容更新同大小同时间的 Word 和 Markdown，再次不变不新增文件任务',async()=>{
  await embeddingEnabled(false);
  await pauseSearchOptimize(engine,true);
  const word=join(directory,'report.docx'),note=join(directory,'note.md'),fixed=new Date('2026-01-01T00:00:00Z');
  await document(word,'FIRST content for maintenance');writeFileSync(note,'# Note\n\nFIRST text for maintenance.');
  for(const path of [word,note])utimesSync(path,fixed,fixed);
  await quick();const sizes=[word,note].map(path=>statSync(path).size);
  await document(word,'OTHER content for maintenance');writeFileSync(note,'# Note\n\nOTHER text for maintenance.');
  for(const path of [word,note])utimesSync(path,fixed,fixed);
  expect([word,note].map(path=>statSync(path).size)).toEqual(sizes);
  await quick();expect((await engine.getPage('report.docx'))!.compiled_truth).toContain('OTHER content');expect((await engine.getPage('note'))!.compiled_truth).toContain('OTHER text');
  const [before]=await engine.executeRaw<{n:number}>("SELECT count(*)::int AS n FROM minion_jobs WHERE queue='pmbrain-sync-files'");
  await quick();const [after]=await engine.executeRaw<{n:number}>("SELECT count(*)::int AS n FROM minion_jobs WHERE queue='pmbrain-sync-files'");expect(after.n).toBe(before.n);
},180000);

test('分块数量不变但内容损坏时修补 Word 和 Markdown，并保留原始文件',async()=>{
  const originals=['report.docx','note.md'].map(name=>readFileSync(join(directory,name)));
  for(const slug of ['report.docx','note']){
    const page=await engine.getPage(slug);
    const rows=await engine.executeRaw<{id:number;chunk_text:string}>('SELECT id,chunk_text FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index',[page!.id]);
    await engine.executeRaw('UPDATE content_chunks SET chunk_text=$2 WHERE id=$1',[rows[0].id,'CORRUPTED SAME COUNT']);
    await quick();const chunks=await engine.executeRaw<{id:number;chunk_text:string}>('SELECT id,chunk_text FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index',[page!.id]);expect(chunks).toEqual(rows);
  }
  expect(['report.docx','note.md'].map(name=>readFileSync(join(directory,name)))).toEqual(originals);
},180000);

test('旧维护回执缺少分块指纹时完成一次核验，后续不重复处理',async()=>{
  const options={sourceId:'default',noEmbed:true};const key=syncFileManifestKey({sourceRoot:directory,relativePath:'note.md',options});
  const saved=JSON.parse((await engine.getConfig(key))!);delete saved.chunkHash;await engine.setConfig(key,JSON.stringify(saved));
  await quick();expect(JSON.parse((await engine.getConfig(key))!).chunkHash).toBeString();
  const [before]=await engine.executeRaw<{n:number}>("SELECT count(*)::int AS n FROM minion_jobs WHERE queue='pmbrain-sync-files'");await quick();
  const [after]=await engine.executeRaw<{n:number}>("SELECT count(*)::int AS n FROM minion_jobs WHERE queue='pmbrain-sync-files'");expect(after.n).toBe(before.n);
},120000);

test('深度整理遵守向量暂停和电脑忙闲，后台恢复后只补缺失向量',async()=>{
  cpu=0.95;await pauseSearchOptimize(engine,true);
  await embeddingEnabled(true);
  writeFileSync(join(directory,'vectors.md'),'# Vector task\n\n'+'独立的测试资料需要保留已有成果并确保后台暂停有效。'.repeat(20));
  const before=calls;const task=await runtime.submitDream({preset:'full',sourceId:'default'},'scheduled');
  const organized=await finish(task.id);
  expect(organized.status,JSON.stringify(organized.result)).toBe('completed');
  expect(calls).toBe(before);expect((await loadSearchOptimize(engine)).paused).toBe(true);
  const [preserved]=await engine.executeRaw<{id:number}>("SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug='vectors' AND source_id='default') ORDER BY chunk_index LIMIT 1");
  const vector=JSON.stringify(Array.from({length:dimensions},(_,i)=>i===0?1:0));await engine.executeRaw("UPDATE content_chunks SET embedding=$2::vector,model='custom-openai:audit-test',embedded_at='2026-01-01T00:00:00Z' WHERE id=$1",[preserved.id,vector]);
  await runtime.close();runtime=new ProductTaskRuntime(engine,{background:{sample:()=>({cpuBusyRatio:cpu,bytes:1024**3,availableBytes:12*1024**3,totalBytes:16*1024**3,systemIdleSeconds:0})}});await runtime.start();
  expect((await loadSearchOptimize(engine)).paused).toBe(true);await Bun.sleep(300);expect(calls).toBe(before);
  const [vectorJob]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE idempotency_key='search-optimize:active'");
  expect(vectorJob).toBeDefined();
  await runtime.continueSearchOptimize('task-'+vectorJob.id);await Bun.sleep(7000);expect(calls).toBe(before);
  cpu=0.1;await waitUntil(async()=>pageEmbedded('vectors'),'解除暂停后没有补齐缺失向量');expect(calls).toBeGreaterThan(before);
  const page=await engine.getPage('vectors');const [stats]=await engine.executeRaw<{pending:number}>("SELECT count(*)::int AS pending FROM content_chunks WHERE page_id=$1 AND embedding IS NULL",[page!.id]);expect(stats.pending).toBe(0);
  const [kept]=await engine.executeRaw<{model:string;embedded_at:Date}>("SELECT model,embedded_at FROM content_chunks WHERE id=$1",[preserved.id]);expect(kept.model).toBe('custom-openai:audit-test');expect(new Date(kept.embedded_at).getUTCFullYear()).toBe(2026);expect(new Date(kept.embedded_at).getUTCMonth()).toBe(0);
  const done=calls;await quick();await Bun.sleep(200);expect(calls).toBe(done);
},180000);

test('深度整理同样等待全局暂停，继续后在原任务完成',async()=>{
  cpu=0.95;await pauseSearchOptimize(engine,true);writeFileSync(join(directory,'deep.md'),'# Deep maintenance\n\n这是独立的深度整理资料，向量应等待后台恢复。');
  const before=calls;const task=await runtime.submitDream({preset:'full',sourceId:'default'},'scheduled');
  const organized=await finish(task.id);
  expect(organized.status,JSON.stringify(organized.result)).toBe('completed');expect(calls).toBe(before);
  expect((await engine.getChunks('deep',{sourceId:'default'})).every(chunk=>!chunk.embedded_at)).toBe(true);
  await pauseSearchOptimize(engine,false);cpu=0.1;
  await waitUntil(async()=>pageEmbedded('deep'),'继续后没有补齐深度整理向量');
  expect(calls).toBeGreaterThan(before);
},180000);

test('深度整理完成不受后台向量费用影响，空闲后只补该资料',async()=>{
  await pauseSearchOptimize(engine,false);cpu=0.1;await engine.setConfig('dream.task_budget_cny','0.000000001');
  try {
    writeFileSync(join(directory,'budget.md'),'# Budget\n\n已有维护预算必须约束向量阶段的模型调用。');
    const before=calls,task=await runtime.submitDream({preset:'full',sourceId:'default'},'scheduled');const done=await finish(task.id);
    expect(done.status,JSON.stringify(done.result)).toBe('completed');expect(calls).toBe(before);
    expect((await engine.getChunks('budget',{sourceId:'default'})).every(chunk=>!chunk.embedded_at)).toBe(true);
    await waitUntil(async()=>pageEmbedded('budget'),'空闲后没有补齐该资料向量');expect(calls).toBeGreaterThan(before);
  } finally { await engine.setConfig('dream.task_budget_cny','1'); }
},180000);

test('向量处理中电脑变忙时保存当前批次，重启及暂停后只补剩余分块并累计原预算',async()=>{
  await embeddingEnabled(true);await pauseSearchOptimize(engine,false);cpu=0.1;
  const windowRoot=join(root,'window');mkdirSync(windowRoot);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('window','分批恢复验收',$1)",[windowRoot]);
  writeFileSync(join(windowRoot,'window.md'),'# Window\n\n'+'向量批次提交后应当保留成果，电脑资源繁忙时暂停，恢复后不能再次收费处理相同分块。'.repeat(500));
  onEmbedding=async()=>{cpu=0.95;};const before=calls;
  const task=await runtime.submitDream({preset:'full',sourceId:'window'},'scheduled');
  const organized=await finish(task.id);
  expect(organized.status,JSON.stringify(organized.result)).toBe('completed');
  await waitUntil(async()=>calls>=before+1,'后台向量没有开始');
  await Bun.sleep(1500);
  expect(calls).toBe(before+1);
  const kept=await engine.executeRaw<{id:number;model:string;embedded_at:Date}>('SELECT c.id,c.model,c.embedded_at FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND c.embedding IS NOT NULL ORDER BY c.id',['window']);
  expect(kept.length).toBeGreaterThan(0);expect(await engine.countStaleChunks({sourceId:'window'})).toBeGreaterThan(0);
  await pauseSearchOptimize(engine,true);await runtime.close();runtime=new ProductTaskRuntime(engine,{background:{sample:()=>({cpuBusyRatio:cpu,bytes:1024**3,availableBytes:12*1024**3,totalBytes:16*1024**3,systemIdleSeconds:0})}});await runtime.start();
  await Bun.sleep(300);expect((await loadSearchOptimize(engine)).paused).toBe(true);expect(calls).toBe(before+1);
  const [windowJob]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE idempotency_key='search-optimize:active'");
  expect(windowJob).toBeDefined();cpu=0.1;await runtime.continueSearchOptimize('task-'+windowJob.id);
  await waitUntil(async()=>await engine.countStaleChunks({sourceId:'window'})===0,'恢复后没有补齐剩余分块');
  expect(await engine.executeRaw('SELECT id,model,embedded_at FROM content_chunks WHERE id=ANY($1::bigint[]) ORDER BY id',[kept.map(row=>row.id)])).toEqual(kept);
},300000);

test('独立同步先保存资料再排队，暂停与电脑繁忙时零向量请求且不处理停用来源',async()=>{
  await embeddingEnabled(true);await pauseSearchOptimize(engine,true);cpu=0.95;
  writeFileSync(join(directory,'sync-pending.md'),'# Sync pending\n\n同步先保存这一份资料，向量化由后台等待电脑空闲后处理。');
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('sync-disabled','停用同步来源','{\"syncEnabled\":false}'::jsonb)");
  await engine.putPage('outside-sync',{type:'note',title:'停用来源',compiled_truth:'未授权本次同步的来源内容必须保留未向量状态。',frontmatter:{}},{sourceId:'sync-disabled'});
  await engine.upsertChunks('outside-sync',[{chunk_index:0,chunk_text:'未授权本次同步的来源内容必须保留未向量状态。',chunk_source:'compiled_truth'}],{sourceId:'sync-disabled'});
  const before=calls,task=await runtime.submitSync(),done=await finish(task.id);
  expect(done.status,JSON.stringify(done.result)).toBe('completed');expect((await engine.getPage('sync-pending'))!.compiled_truth).toContain('同步先保存');expect(calls).toBe(before);
  const queued=await loadSearchOptimize(engine);expect(await pendingOptimize('default','sync-pending')).toHaveLength(1);expect(queued.items.some(item=>item.sourceId==='sync-disabled')).toBe(false);expect((await pendingOptimize('sync-disabled','outside-sync'))).toHaveLength(0);
  expect(await engine.countStaleChunks({sourceId:'sync-disabled'})).toBe(1);
  const second=await finish((await runtime.submitSync()).id);expect(second.status,JSON.stringify(second.result)).toBe('completed');expect(calls).toBe(before);expect(await pendingOptimize('default','sync-pending')).toHaveLength(1);
  const [background]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE idempotency_key='search-optimize:active'");expect(background).toBeDefined();cpu=0.1;await runtime.continueSearchOptimize('task-'+background.id);await waitUntil(async()=>pageEmbedded('sync-pending'),'同步资料未在后台补向量');expect(calls).toBeGreaterThan(before);expect(await engine.countStaleChunks({sourceId:'sync-disabled'})).toBe(1);
},180000);
