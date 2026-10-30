import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,utimesSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {createCanvas} from '@napi-rs/canvas';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import type {BrainEngine} from '../src/core/engine';
import {configureGateway,resetGateway,__setChatTransportForTests} from '../src/core/ai/gateway';
import {importOfficeFile} from '../src/core/office-import';
import {configPath} from '../src/core/config';
import {DocumentRuntime} from '../src/core/document/resource-policy';
import {readContentChunksEmbeddingDim} from '../src/core/embedding-dim-check';
import {PostgresEngine} from '../src/core/postgres-engine';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';
import {MinionQueue} from '../src/core/minions/queue';
import {SyncFileQueue,SYNC_FILE_QUEUE} from '../src/product/tasks/sync-file-queue';
import {syncFileContentFingerprint} from '../src/product/tasks/checkpoint';
import type {SyncFileInput} from '../src/product/tasks/types';
const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let root:string,engine:BrainEngine,calls=0,failAt=-1,onModel:(()=>void)|undefined;
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-reimport-legacy-'));
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  mkdirSync(join(root,'.pmbrain'));writeFileSync(configPath(),JSON.stringify({engine:'pglite',database_path:join(root,'database'),model_usage:{embedding_enabled:false}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  engine=(database?new PostgresEngine():new WorkerPgliteEngine()) as unknown as BrainEngine;await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();
  configureGateway({generative_enabled:true,chat_model:'mimo:mimo-v2.6-flash',env:{MIMO_API_KEY:'isolated-test-only'}});
  __setChatTransportForTests(async()=>{calls++;onModel?.();const text='OCR fixture evidence '+calls;return {text,blocks:[{type:'text',text}],model:'mimo:mimo-v2.6-flash',providerId:'mimo',usage:{input_tokens:2,output_tokens:2,cache_read_tokens:0,cache_creation_tokens:0},stopReason:failAt>0&&calls>=failAt?'length':'end'};});
},90000);
afterAll(async()=>{
  __setChatTransportForTests(null);resetGateway();await engine?.disconnect();
  for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-reimport-legacy-'))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
},60000);

async function writeWord(path:string,text:string,images=3){
  const zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for(let i=0;i<images;i++){const canvas=createCanvas(32,32),context=canvas.getContext('2d');context.fillStyle=['#ff0000','#00ff00','#0000ff','#ffff00'][i%4];context.fillRect(0,0,32,32);zip.file('word/media/image'+i+'.png',canvas.toBuffer('image/png'));}
  writeFileSync(path,await zip.generateAsync({type:'nodebuffer'}));
}
async function legacyFixture(name:string,failedStart=0,text='OriginalLegacyNativeText',images=3){
  const sourceId='legacy-'+name+'-'+Date.now().toString(36),dir=join(root,sourceId);mkdirSync(dir);const path=join(dir,'report.docx');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[sourceId,dir]);await writeWord(path,text,images);
  failAt=failedStart?calls+failedStart:-1;const options={sourceId,noEmbed:true,documentOcr:true};await importOfficeFile(engine,path,'report.docx',options);failAt=-1;
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_chunk_count'-'document_chunk_hash' WHERE source_id=$1",[sourceId]);
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'document.ocr.v1.%'");
  return {sourceId,dir,path,options};
}
const stored=(sourceId:string)=>engine.executeRaw<{id:number;chunk_index:number;chunk_text:string;embedding:string|null;model:string|null;embedded_at:string|null}>('SELECT c.id,c.chunk_index,c.chunk_text,c.embedding::text AS embedding,c.model,c.embedded_at::text AS embedded_at FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 ORDER BY c.chunk_index',[sourceId]);
async function seedVector(sourceId:string){
  const dimensions=await readContentChunksEmbeddingDim(engine);if(!dimensions.dims)throw new Error('isolated vector dimensions missing');const vector=Array(dimensions.dims).fill(0);vector[0]=1;
  await engine.executeRaw("UPDATE content_chunks SET embedding=$2::vector,model='fixture:preserved',embedded_at=now() WHERE id=(SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 ORDER BY c.chunk_index LIMIT 1)",[sourceId,JSON.stringify(vector)]);
}
test('完整旧资料认领回执时正文、版本、时间和已有向量不变，改根路径仍复用',async()=>{
  const f=await legacyFixture('preserve');await seedVector(f.sourceId);const before=await engine.getPage('report.docx',{sourceId:f.sourceId}),chunks=await stored(f.sourceId),bytes=readFileSync(f.path),count=calls;
  expect((await importOfficeFile(engine,f.path,'nested/report.docx',f.options)).status).toBe('skipped');
  const after=await engine.getPage('report.docx',{sourceId:f.sourceId});expect(calls).toBe(count);expect(after!.compiled_truth).toBe(before!.compiled_truth);expect(after!.content_hash).toBe(before!.content_hash);expect(String(after!.updated_at)).toBe(String(before!.updated_at));expect(await stored(f.sourceId)).toEqual(chunks);expect(readFileSync(f.path)).toEqual(bytes);
  expect((await engine.executeRaw<{count:number}>('SELECT count(*)::int AS count FROM page_versions WHERE page_id=$1',[before!.id]))[0].count).toBe(0);
},60000);
test('旧识图仅补失败项，已有正文保持原前缀、分块 ID 和向量不变，下次零请求',async()=>{
  const f=await legacyFixture('append',3);await seedVector(f.sourceId);const before=await engine.getPage('report.docx',{sourceId:f.sourceId}),chunks=await stored(f.sourceId),count=calls;
  const result=await importOfficeFile(engine,f.path,'report.docx',f.options);expect(calls-count).toBe(1);expect(result.status).toBe('imported');
  const after=await engine.getPage('report.docx',{sourceId:f.sourceId});expect(after!.compiled_truth.startsWith(before!.compiled_truth)).toBe(true);const rows=await stored(f.sourceId);expect(rows.slice(0,chunks.length)).toEqual(chunks);expect(rows.length).toBeGreaterThan(chunks.length);
  const done=calls;expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).status).toBe('skipped');expect(calls).toBe(done);
},60000);
test('旧资料缺块和同数量坏块从已存正文修补，不重新识图，保留正常分块向量',async()=>{
  const f=await legacyFixture('repair',0,'可检索的原生内容 OriginalLegacyNativeText。'.repeat(400));await seedVector(f.sourceId);const rows=await stored(f.sourceId),page=await engine.getPage('report.docx',{sourceId:f.sourceId});expect(rows.length).toBeGreaterThan(3);
  await engine.executeRaw('DELETE FROM content_chunks WHERE id=$1',[rows[1].id]);await engine.executeRaw("UPDATE content_chunks SET chunk_text='CorruptedUniqueChunkToken' WHERE id=$1",[rows.at(-1)!.id]);const count=calls;
  const result=await importOfficeFile(engine,f.path,'report.docx',f.options);expect(result.status).toBe('imported');expect(calls).toBe(count);expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toBe(page!.compiled_truth);expect((await stored(f.sourceId))[0]).toEqual(rows[0]);
  expect((await stored(f.sourceId)).some(row=>row.chunk_text.includes('CorruptedUniqueChunkToken'))).toBe(false);expect((await stored(f.sourceId)).map(row=>row.chunk_text).join('\n')).toContain('OCR fixture evidence');
  const current=await stored(f.sourceId);await engine.executeRaw("UPDATE content_chunks SET chunk_text='SecondCorruptionToken' WHERE id=$1",[current.at(-1)!.id]);await importOfficeFile(engine,f.path,'report.docx',f.options);expect(calls).toBe(count);expect((await stored(f.sourceId)).some(row=>row.chunk_text.includes('SecondCorruptionToken'))).toBe(false);
},60000);
test('失败图片识别一批后停止并重开，复用缓存且只请求剩余一张',async()=>{
  const f=await legacyFixture('resume',2,'OriginalLegacyNativeText',4),controller=new AbortController(),count=calls,original=await engine.getPage('report.docx',{sourceId:f.sourceId});
  onModel=()=>{if(calls-count===2)controller.abort(new Error('isolated stop'));};
  let failure:unknown;try{await importOfficeFile(engine,f.path,'report.docx',{...f.options,runtime:new DocumentRuntime({signal:controller.signal})});}catch(error){failure=error;}finally{onModel=undefined;}expect(String(failure)).toContain('isolated stop');expect(calls-count).toBe(2);
  const partial=await engine.getPage('report.docx',{sourceId:f.sourceId});await engine.disconnect();engine=(database?new PostgresEngine():new WorkerPgliteEngine()) as unknown as BrainEngine;await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});
  expect(partial!.compiled_truth).toBe(original!.compiled_truth);
  const before=calls;await importOfficeFile(engine,f.path,'report.docx',f.options);expect(calls-before).toBe(1);const final=await engine.getPage('report.docx',{sourceId:f.sourceId});expect(final!.compiled_truth.startsWith(partial!.compiled_truth)).toBe(true);expect((final!.frontmatter.ocr_receipt as any).status).toBe('complete');
},90000);
test('识图期间原文件变化拒绝追加，旧正文和向量保留',async()=>{
  const f=await legacyFixture('source-change',3);await seedVector(f.sourceId);const page=await engine.getPage('report.docx',{sourceId:f.sourceId}),chunks=await stored(f.sourceId);onModel=()=>writeFileSync(f.path,Buffer.concat([readFileSync(f.path),Buffer.from('changed')]));
  let failure:unknown;try{await importOfficeFile(engine,f.path,'report.docx',f.options);}catch(error){failure=error;}finally{onModel=undefined;}expect(String(failure)).toContain('已修改');expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toBe(page!.compiled_truth);expect(await stored(f.sourceId)).toEqual(chunks);
},60000);
test('同大小同时间的源文件变更正常处理，Source 不同不复用旧回执',async()=>{
  const f=await legacyFixture('changed');await importOfficeFile(engine,f.path,'report.docx',f.options);const before=statSync(f.path);await writeWord(f.path,'ModifiedLegacyNativeText');utimesSync(f.path,before.atime,before.mtime);expect(statSync(f.path).size).toBe(before.size);
  expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).status).toBe('imported');expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('ModifiedLegacyNativeText');
  const other='legacy-other-'+Date.now().toString(36);await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[other,join(root,other)]);const count=calls;await importOfficeFile(engine,f.path,'report.docx',{...f.options,sourceId:other});expect(calls-count).toBe(3);
},60000);
test('失败位置缺失时明确部分完成，不能重新识别全部图片',async()=>{
  const f=await legacyFixture('unlocated',3);await engine.executeRaw("UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{ocr_receipt,failedItems}','[]'::jsonb) WHERE source_id=$1",[f.sourceId]);const before=await engine.getPage('report.docx',{sourceId:f.sourceId}),count=calls;
  const result=await importOfficeFile(engine,f.path,'report.docx',f.options);expect(result.status).toBe('partial');expect(result.error).toContain('定位');expect(calls).toBe(count);expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toBe(before!.compiled_truth);
},60000);
test('只读预检不认领回执、不改正文和分块、不请求图片模型',async()=>{
  const f=await legacyFixture('check-only');const before=await engine.getPage('report.docx',{sourceId:f.sourceId}),chunks=await stored(f.sourceId),count=calls;
  await importOfficeFile(engine,f.path,'report.docx',{...f.options,checkOnly:true});expect(calls).toBe(count);expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.frontmatter).toEqual(before!.frontmatter);expect(await stored(f.sourceId)).toEqual(chunks);
},60000);

for(const documentOcr of [true,false])test(`维护队列识图${documentOcr?'开启':'关闭'}且缺旧回执时不擅自强制重切分，仍可零 OCR 认领旧 Office`,async()=>{
  const f=await legacyFixture('queue-'+documentOcr);await seedVector(f.sourceId);const body=(await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth,chunks=await stored(f.sourceId),info=statSync(f.path),options={...f.options,documentOcr,includeOffice:true};
  const input:SyncFileInput={path:f.path,relativePath:'report.docx',sourceRoot:f.dir,originalPath:f.path,originalSize:info.size,originalMtime:info.mtimeMs,hash:createHash('sha256').update(readFileSync(f.path)).digest('hex'),fingerprint:syncFileContentFingerprint(options),modelFingerprint:'isolated',options};
  const queue=new MinionQueue(engine),parent=await queue.add('legacy-queue-parent',{}, {queue:'legacy-queue'});await queue.claim('legacy-queue-token',3600000,'legacy-queue',['legacy-queue-parent']);
  const files=new SyncFileQueue(engine);expect((await files.enqueue(parent.id,'legacy-queue-token',input)).deferred).toBe(true);
  const [row]=await engine.executeRaw<{data:{task:{input:SyncFileInput}}}>('SELECT data FROM minion_jobs WHERE queue=$1 AND parent_job_id=$2',[SYNC_FILE_QUEUE,parent.id]);const queued=row.data.task.input;
  expect(queued.options.forceRechunk).not.toBe(true);const count=calls;expect((await importOfficeFile(engine,queued.path,queued.relativePath,queued.options)).status).toBe('skipped');expect(calls).toBe(count);expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toBe(body);expect(await stored(f.sourceId)).toEqual(chunks);
},60000);

test('修补分块第一批提交后中断不能标记完整，重开仅补剩余片段',async()=>{
  const text=Array.from({length:120},(_,index)=>`LegacyParagraph${index} 独立正文内容${index}。`+'需要完整保留的材料。'.repeat(20)).join('\n\n'),f=await legacyFixture('repair-resume',0,text);await seedVector(f.sourceId);
  const before=await stored(f.sourceId);await engine.executeRaw('DELETE FROM content_chunks WHERE id=ANY($1::int[])',[before.slice(1).map(chunk=>chunk.id)]);
  const controller=new AbortController(),runtime=new DocumentRuntime({signal:controller.signal,sample:()=>({bytes:0,availableBytes:3*1024**3,totalBytes:8*1024**3,cpuBusyRatio:0.95})}),count=calls;let interrupted=false;
  const proxy=new Proxy(engine,{get(target,key){if(key==='transaction')return async(fn:any)=>{const value=await target.transaction(fn),page=await target.getPage('report.docx',{sourceId:f.sourceId});if(!interrupted&&(page!.frontmatter.document_legacy_reuse as any)?.verified===false){interrupted=true;controller.abort(new Error('isolated repair stop'));}return value;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  let failure:unknown;try{await importOfficeFile(proxy,f.path,'report.docx',{...f.options,runtime});}catch(error){failure=error;}expect(String(failure)).toContain('isolated repair stop');
  const committed=await stored(f.sourceId);expect(committed.length).toBeGreaterThan(1);expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.frontmatter.document_legacy_reuse).toMatchObject({verified:false});
  await importOfficeFile(engine,f.path,'report.docx',f.options);const after=await stored(f.sourceId);expect(committed.every(chunk=>after.some(saved=>JSON.stringify(chunk)===JSON.stringify(saved)))).toBe(true);expect(calls).toBe(count);
  expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.frontmatter.document_legacy_reuse).toMatchObject({verified:true});expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).status).toBe('skipped');
},90000);

for(const format of ['pptx','xlsx'])test(`旧 ${format} 只补失败图片，保留已经保存的正文和分块`,async()=>{
  const sourceId='legacy-'+format+'-'+Date.now().toString(36),dir=join(root,sourceId);mkdirSync(dir);await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[sourceId,dir]);
  const path=join(dir,'report.'+format);let zip:JSZip;
  if(format==='xlsx'){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['标题','内容'],['甲','原有表格']]),'资料');zip=await JSZip.loadAsync(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));}
  else{zip=new JSZip();zip.file('ppt/slides/slide1.xml','<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>原有幻灯片文字</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');}
  for(let index=0;index<3;index++){const canvas=createCanvas(32,32),context=canvas.getContext('2d');context.fillStyle=['#ff0000','#00ff00','#0000ff'][index];context.fillRect(0,0,32,32);zip.file(`${format==='pptx'?'ppt':'xl'}/media/image${index}.png`,canvas.toBuffer('image/png'));}
  writeFileSync(path,await zip.generateAsync({type:'nodebuffer'}));const options={sourceId,noEmbed:true,documentOcr:true};failAt=calls+3;
  expect((await importOfficeFile(engine,path,'report.'+format,options)).status).toBe('partial');failAt=-1;
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_chunk_count'-'document_chunk_hash' WHERE source_id=$1",[sourceId]);await engine.executeRaw("DELETE FROM config WHERE key LIKE 'document.ocr.v1.%'");
  const before=await engine.getPage('report.'+format,{sourceId}),chunks=await stored(sourceId),count=calls;expect((await importOfficeFile(engine,path,'report.'+format,options)).status).toBe('imported');expect(calls-count).toBe(1);
  expect((await engine.getPage('report.'+format,{sourceId}))!.compiled_truth.startsWith(before!.compiled_truth)).toBe(true);expect((await stored(sourceId)).slice(0,chunks.length)).toEqual(chunks);
},60000);
for(const partial of [false,true])test(partial?'旧版已成功两图只失败一图，重导只应请求失败图':'旧版完整资料缺少新回执，重导不应重新识别三图',async()=>{
  const sourceId=partial?'legacy-partial':'legacy-complete',dir=join(root,sourceId);mkdirSync(dir);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[sourceId,dir]);
  const path=join(dir,'report.docx'),zip=new JSZip();zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>unchanged legacy source</w:t></w:r></w:p></w:body></w:document>');
  for(let i=0;i<3;i++){const canvas=createCanvas(32,32),context=canvas.getContext('2d');context.fillStyle=['#ff0000','#00ff00','#0000ff'][i];context.fillRect(0,0,32,32);zip.file('word/media/image'+i+'.png',canvas.toBuffer('image/png'));}
  writeFileSync(path,await zip.generateAsync({type:'nodebuffer'}));
  const options={sourceId,noEmbed:true,documentOcr:true};failAt=partial?calls+3:-1;
  const first=await importOfficeFile(engine,path,'report.docx',options);expect(first.status).toBe(partial?'partial':'imported');
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_chunk_count'-'document_chunk_hash' WHERE source_id=$1",[sourceId]);
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'document.ocr.v1.%'");
  const before=calls;failAt=-1;const next=await importOfficeFile(engine,path,'report.docx',options);
  const result={case:sourceId,repeatedOcrRequests:calls-before,expectedOcrRequests:partial?1:0,status:next.status};console.log(JSON.stringify(result));
  expect(calls-before).toBe(partial?1:0);
},60000);
