import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,utimesSync,rmSync,unlinkSync,existsSync} from 'node:fs';
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
let root:string,dir:string,engine:BrainEngine,runtime:ProductTaskRuntime,server:ReturnType<typeof Bun.serve>,cpu=0.95,calls=0,failAt=-1,batchMissing=false;
let dimensions=1280,embeddingCalls=0,captureCalls=0,holdOcr:Promise<void>|undefined;const events:string[]=[],captureSources:string[]=[];
const database=process.env.PMBRAIN_DOCUMENT_OCR_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-deferred-ocr-'));dir=join(root,'materials');mkdirSync(dir);mkdirSync(join(root,'.pmbrain'));for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json() as any;if(new URL(request.url).pathname.endsWith('/embeddings')){embeddingCalls++;events.push('embed');const inputs=Array.isArray(body.input)?body.input:[body.input];return Response.json({data:inputs.map((_:unknown,index:number)=>({index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'deferred-embed',usage:{prompt_tokens:inputs.length,total_tokens:inputs.length}});}if(!JSON.stringify(body).includes('data:image/')){captureCalls++;captureSources.push(JSON.stringify(body));events.push('capture');if(JSON.stringify(body).includes('chain.docx'))events.push('chain_capture');return Response.json({choices:[{message:{role:'assistant',content:JSON.stringify({entities:[],relations:[],no_entities:true})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}const call=++calls;events.push('ocr');if(holdOcr)await holdOcr;if(call===failAt)return Response.json({error:{message:'fixture OCR rejected'}},{status:400});const parts=(body.messages??[]).flatMap((message:any)=>Array.isArray(message.content)?message.content:[]),ids=parts.flatMap((part:any)=>typeof part.text==='string'&&/^Image id: /.test(part.text)?[part.text.match(/^Image id: ([^.]+)\./)?.[1]]:[]);const content=ids.length?JSON.stringify((batchMissing?ids.slice(0,1):ids).map((id:string)=>({id,text:`DeferredBatchEvidence ${id}`}))):'DeferredEvidence '+call;return Response.json({choices:[{message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}});
  if(database)assertSafeE2eDatabaseUrl(database);
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',...(database?{database_url:database}:{database_path:join(root,'database')}),custom_openai_api_key:'isolated-only',models:{default:'custom-openai:isolated-office-ocr'},provider_base_urls:{'custom-openai':server.url.origin+'/v1'},model_usage:{generative_enabled:true,embedding_enabled:false}}));
  engine=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();const [existing]=await engine.executeRaw<{n:number}>('SELECT count(*)::int n FROM pages');if(existing.n)throw Error('后台识图回归需要全新的隔离测试库，拒绝覆盖已有资料');await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[dir]);await engine.setConfig('dream.entity_capture.enabled','false');await engine.setConfig('dream.knowledge.enabled','false');await reloadLiveGateway(engine);await start();
},90000);
afterAll(async()=>{await runtime?.close();await engine?.disconnect();server?.stop(true);resetGateway();for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-deferred-ocr-'))throw Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}},60000);
async function word(name:string,text='Native text stays available'){
  const path=join(dir,name+'.docx'),zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for(let index=0;index<3;index++){const canvas=createCanvas(40,40),ctx=canvas.getContext('2d');ctx.fillStyle='#'+createHash('sha256').update(name+index).digest('hex').slice(0,6);ctx.fillRect(0,0,40,40);zip.file('word/media/image'+index+'.png',canvas.toBuffer('image/png'));}writeFileSync(path,await zip.generateAsync({type:'nodebuffer'}));return path;
}
function scannedPdf(name:string,pageCount=2){
  const path=join(dir,name+'.pdf'),images=Array.from({length:pageCount},(_,index)=>{const canvas=createCanvas(128,128),ctx=canvas.getContext('2d');ctx.fillStyle='#'+createHash('sha256').update(name+index).digest('hex').slice(0,6);ctx.fillRect(0,0,128,128);return canvas.toBuffer('image/jpeg');});
  const streams=images.map((_,index)=>`q 500 0 0 500 40 120 cm /Im${index+1} Do Q`),imageBase=3+pageCount*2;
  const objects:Buffer[]=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from(`<< /Type /Pages /Kids [${images.map((_,index)=>`${3+index*2} 0 R`).join(' ')}] /Count ${pageCount} >>`)];
  for(let i=0;i<pageCount;i++){objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im${i+1} ${imageBase+i} 0 R >> >> /Contents ${4+i*2} 0 R >>`));objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(streams[i])} >>\nstream\n${streams[i]}\nendstream`));}
  for(const image of images)objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 128 /Height 128 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]));
  const parts=[Buffer.from('%PDF-1.4\n')],offsets:number[]=[];let length=parts[0].length;
  objects.forEach((object,index)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);parts.push(part);length+=part.length;});
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));writeFileSync(path,Buffer.concat(parts));return path;
}
function textPdf(name:string){
  const path=join(dir,name+'.pdf'),stream='BT /F1 14 Tf 40 760 Td (Native searchable PDF text) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const parts=[Buffer.from('%PDF-1.4\n')],offsets:number[]=[];let length=parts[0].length;
  objects.forEach((object,index)=>{offsets.push(length);const part=Buffer.from(`${index+1} 0 obj\n${object}\nendobj\n`);parts.push(part);length+=part.length;});
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));writeFileSync(path,Buffer.concat(parts));return path;
}
async function start(){runtime=new ProductTaskRuntime(engine,{background:{sample:()=>({cpuBusyRatio:cpu,bytes:1024**3,availableBytes:12*1024**3,totalBytes:16*1024**3,systemIdleSeconds:100})}});await runtime.start();}
async function vectorConfiguration(){
  dimensions=(await readContentChunksEmbeddingDim(engine)).dims!;const config=JSON.parse(readFileSync(configPath(),'utf8'));config.embedding_model='custom-openai:deferred-embed';config.embedding_dimensions=dimensions;config.model_usage.embedding_enabled=true;writeFileSync(configPath(),JSON.stringify(config));await reloadLiveGateway(engine);
  await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:isolated-office-ocr':{input:1,output:1},'custom-openai:deferred-embed':{input:1,output:0}}));
}
async function finish(id:number){const until=Date.now()+60000;let last:any;while(Date.now()<until){last=await runtime.getRun('task-'+id);if(last&&!['running','queued'].includes(last.status))return last;await Bun.sleep(60);}throw Error('OCR task timeout '+JSON.stringify({run:last,rows:await engine.executeRaw('SELECT id,name,queue,status,attempts_started,progress,error_text FROM minion_jobs')}));}
const options={sourceId:'default',noEmbed:true,documentOcr:true,deferDocumentOcr:true};

test('快速维护不发起识图，保留旧资料已识别的图片文字',async()=>{
  const folder=join(root,'quick-no-model');mkdirSync(folder);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('quick-no-model','快速维护识图边界',$1,'{\"includeOffice\":true}'::jsonb)",[folder]);
  const original=await word('quick-no-model-input','需要保留的正文。'),path=join(folder,'material.docx');writeFileSync(path,readFileSync(original));unlinkSync(original);
  cpu=0.95;const imported=await importOfficeFile(engine,path,'material.docx',{...options,sourceId:'quick-no-model'});
  cpu=0.1;expect((await finish(imported.ocrTaskId!)).status).toBe('completed');
  const beforeBody=(await engine.getPage('material.docx',{sourceId:'quick-no-model'}))!.compiled_truth;
  expect(beforeBody).toContain('DeferredEvidence');
  const before=[calls,embeddingCalls,captureCalls];cpu=0.95;
  const task=await runtime.submitDream({preset:'quick',sourceId:'quick-no-model'});
  const done=await finish(Number(task.id.slice(5)));
  expect(done.status,JSON.stringify(done.result)).toBe('completed');
  expect([calls,embeddingCalls,captureCalls]).toEqual(before);
  expect((await engine.getPage('material.docx',{sourceId:'quick-no-model'}))!.compiled_truth).toBe(beforeBody);
  const revised=await word('quick-no-model-input','正文已经更新，图片没有变化。');writeFileSync(path,readFileSync(revised));unlinkSync(revised);
  const changed=await runtime.submitDream({preset:'quick',sourceId:'quick-no-model'});
  const changedDone=await finish(Number(changed.id.slice(5)));
  expect(changedDone.status,JSON.stringify(changedDone.result)).toBe('completed');
  const changedBody=(await engine.getPage('material.docx',{sourceId:'quick-no-model'}))!.compiled_truth;
  expect(changedBody).toContain('正文已经更新');
  expect(changedBody).toContain('DeferredEvidence');
  expect([calls,embeddingCalls,captureCalls]).toEqual(before);
  const canvas=createCanvas(40,40);canvas.getContext('2d').fillRect(0,0,40,40);
  writeFileSync(join(folder,'new-image.png'),canvas.toBuffer('image/png'));
  const imageTask=await runtime.submitDream({preset:'quick',sourceId:'quick-no-model'});
  expect((await finish(Number(imageTask.id.slice(5)))).status).toBe('completed');
  expect(await engine.getPage('new-image.png',{sourceId:'quick-no-model'})).not.toBeNull();
  expect([calls,embeddingCalls,captureCalls]).toEqual(before);
},180000);

test('可直接读取的 PDF 保存文字，不创建识图任务',async()=>{
  const path=textPdf('native-text'),before=calls,original=readFileSync(path),result=await importOfficeFile(engine,path,'native-text.pdf',options as any);
  expect(result.ocrPending??0).toBe(0);expect(result.ocrTaskId).toBeUndefined();expect(calls).toBe(before);
  expect((await engine.getPage(result.slug))!.compiled_truth).toContain('Native searchable PDF text');expect(readFileSync(path)).toEqual(original);
},120000);

test('后台扫描 PDF 把两页合并请求，分别保存页码和内容',async()=>{
  cpu=0.95;const path=scannedPdf('batched-pages'),before=calls;
  const initial=await importOfficeFile(engine,path,'batched-pages.pdf',options as any);
  expect(initial.ocrPending).toBe(2);expect(calls).toBe(before);
  cpu=0.1;const done=await finish(initial.ocrTaskId!);
  expect(done.status,JSON.stringify(done)).toBe('completed');expect(calls-before).toBe(1);
  const page=(await engine.getPage(initial.slug))!;
  expect(page.compiled_truth).toContain('DeferredBatchEvidence 1');expect(page.compiled_truth).toContain('DeferredBatchEvidence 2');
  expect((page.frontmatter.ocr_receipt as any).status).toBe('complete');
},120000);

test('四页扫描 PDF 分两次请求，各页内容按原页码保存',async()=>{
  cpu=0.95;const path=scannedPdf('four-pages',4),before=calls,initial=await importOfficeFile(engine,path,'four-pages.pdf',options as any);
  expect(initial.ocrPending).toBe(4);cpu=0.1;expect((await finish(initial.ocrTaskId!)).status).toBe('completed');expect(calls-before).toBe(2);
  const rows=await engine.executeRaw<{chunk_text:string}>('SELECT c.chunk_text FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 AND p.source_id=$2',[initial.slug,'default']);
  for(let page=1;page<=4;page++)expect(rows.some(row=>row.chunk_text.includes(`Locator: 第 ${page} 页`)&&row.chunk_text.includes(`DeferredBatchEvidence ${(page-1)%2+1}`))).toBe(true);
},120000);

test('多页返回缺页时保留原文和待处理状态，继续后可正确补齐',async()=>{
  cpu=0.95;const path=scannedPdf('batch-missing'),before=calls,initial=await importOfficeFile(engine,path,'batch-missing.pdf',options as any);
  const original=(await engine.getPage(initial.slug))!.compiled_truth;batchMissing=true;cpu=0.1;
  try{
    const failed=await finish(initial.ocrTaskId!);expect(failed.status).toBe('failed');expect(failed.error).toContain('识图');
    expect((await engine.getPage(initial.slug))!.compiled_truth).toBe(original);
    batchMissing=false;await runtime.retry('task-'+initial.ocrTaskId);
    expect((await finish(initial.ocrTaskId!)).status).toBe('completed');expect(calls-before).toBe(2);
    const page=(await engine.getPage(initial.slug))!;expect(page.compiled_truth).toContain('DeferredBatchEvidence 1');expect(page.compiled_truth).toContain('DeferredBatchEvidence 2');
  }finally{batchMissing=false;}
},120000);

test('扫描 PDF 识图时原文件变化，旧结果不写回知识库',async()=>{
  cpu=0.95;const path=scannedPdf('batch-changed'),initial=await importOfficeFile(engine,path,'batch-changed.pdf',options as any),original=(await engine.getPage(initial.slug))!.compiled_truth;
  let release!:()=>void;holdOcr=new Promise<void>(resolve=>{release=resolve;});const before=calls;cpu=0.1;
  try{
    const until=Date.now()+60000;while(calls===before&&Date.now()<until)await Bun.sleep(60);expect(calls).toBe(before+1);
    const stat=statSync(path),bytes=readFileSync(path);bytes[bytes.length-2]^=1;writeFileSync(path,bytes);utimesSync(path,stat.atime,stat.mtime);expect(statSync(path).size).toBe(stat.size);
  }finally{holdOcr=undefined;release();}
  expect((await finish(initial.ocrTaskId!)).status).toBe('failed');expect((await engine.getPage(initial.slug))!.compiled_truth).toBe(original);
},120000);

test('两份独立图片可同时识图，互相不当作前台任务阻塞',async()=>{
  cpu=0.95;const jobs:number[]=[];
  for(const [index,color] of ['#aa3322','#2244aa'].entries()){
    const path=join(dir,`parallel-image-${index}.png`),canvas=createCanvas(40,40),ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,40,40);writeFileSync(path,canvas.toBuffer('image/png'));
    const result=await importImageFile(engine,path,`parallel-image-${index}.png`,{sourceId:'default',noEmbed:true,forceOcr:true,deferDocumentOcr:true});
    jobs.push(result.ocrTaskId!);
  }
  let release!:()=>void;holdOcr=new Promise<void>(resolve=>{release=resolve;});const before=calls;cpu=0.1;
  try{
    const until=Date.now()+45000;while(calls-before<2&&Date.now()<until)await Bun.sleep(60);
    expect(calls-before,JSON.stringify(await Promise.all(jobs.map(id=>runtime.getRun('task-'+id))))).toBe(2);
  }finally{holdOcr=undefined;release();}
  for(const id of jobs)expect((await finish(id)).status).toBe('completed');
},120000);

test('普通导入和后台识图不自动启动实体整理，明确整理仍可处理资料',async()=>{
  cpu=0.95;const folder=join(root,'import-no-capture');mkdirSync(folder);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('import-no-capture','导入隔离',$1,'{}'::jsonb)",[folder]);
  await engine.setConfig('dream.entity_capture.enabled','true');
  await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:isolated-office-ocr':{input:1,output:1}}));
  const path=join(folder,'material.md');writeFileSync(path,'# 原文\n\n这是一份用于验证导入后不会自动整理实体的完整资料。');
  const before=captureCalls;
  try{
    const imported=await runtime.submitImport({path,sourceId:'import-no-capture',noEmbed:true,documentOcr:false});
    expect((await finish(Number(imported.id.slice(5)))).status).toBe('completed');
    await Bun.sleep(1500);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'sourceId'='import-no-capture' AND data->'task'->'input'->>'phase'='capture_entities'")).toHaveLength(0);
    expect(captureCalls).toBe(before);
    expect(await engine.getConfig('dream.entity_capture.pending.import-no-capture')).toContain('material');
    const original=await word('no-capture-image'),imagePath=join(folder,'with-image.docx');writeFileSync(imagePath,readFileSync(original));unlinkSync(original);
    const imageImport=await runtime.submitImport({path:imagePath,sourceId:'import-no-capture',noEmbed:true,documentOcr:true});
    const saved=await finish(Number(imageImport.id.slice(5)));expect(saved.status).toBe('completed');
    const imageJob=(saved.result as {ocrTaskIds:number[]}).ocrTaskIds[0];cpu=0.1;expect((await finish(imageJob)).status).toBe('completed');
    await Bun.sleep(1500);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE data->'task'->'input'->>'sourceId'='import-no-capture' AND data->'task'->'input'->>'phase'='capture_entities'")).toHaveLength(0);
    expect(captureCalls).toBe(before);
    const explicit=await runtime.submitDream({phase:'capture_entities',sourceId:'import-no-capture',slugs:['material']});
    expect((await finish(Number(explicit.id.slice(5)))).status).toBe('completed');
    expect(captureCalls).toBeGreaterThan(before);
  }finally{await engine.setConfig('dream.entity_capture.enabled','false');}
},120000);

test('旧资料已有完整图片文字时，后台识图模式保留正文和分块并完成重复导入',async()=>{
  cpu=0.95;const path=await word('legacy-deferred');
  const first=await importOfficeFile(engine,path,'legacy-deferred.docx',{sourceId:'default',noEmbed:true,documentOcr:true});
  expect(first.status).toBe('imported');
  const page=(await engine.getPage(first.slug))!;const before=calls;
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter||'{\"document_structured\":false}'::jsonb WHERE id=$1",[page.id]);
  const chunks=await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id',[page.id]);
  const metadata=(await engine.getPage(first.slug))!.frontmatter;
  await importOfficeFile(engine,path,'legacy-deferred.docx',{...options,checkOnly:true});
  expect((await engine.getPage(first.slug))!.frontmatter).toEqual(metadata);
  expect(await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id',[page.id])).toEqual(chunks);
  const resumed=await importOfficeFile(engine,path,'legacy-deferred.docx',options);
  expect(['imported','skipped']).toContain(resumed.status);expect(calls).toBe(before);
  expect((await engine.getPage(first.slug))!.compiled_truth).toBe(page.compiled_truth);
  expect((await engine.executeRaw<{type:string}>('SELECT jsonb_typeof(frontmatter) type FROM pages WHERE id=$1',[page.id]))[0].type).toBe('object');
  expect(await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id',[page.id])).toEqual(chunks);
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'ocr_receipt'-'document_chunk_hash' WHERE id=$1",[page.id]);
  const unknown=await importOfficeFile(engine,path,'legacy-deferred.docx',options);
  expect(unknown.status).toBe('partial');expect(unknown.error).toContain('缺少可核验的识图回执');
  expect((await engine.getPage(first.slug))!.compiled_truth).toBe(page.compiled_truth);
  expect(await engine.executeRaw('SELECT id,chunk_text,embedding::text FROM content_chunks WHERE page_id=$1 ORDER BY id',[page.id])).toEqual(chunks);
},120000);

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
    const until=Date.now()+60000;while(calls===before&&Date.now()<until)await Bun.sleep(60);expect(calls-before).toBeGreaterThanOrEqual(1);expect(calls-before).toBeLessThanOrEqual(2);await runtime.adjustResourcePressure(true);
    const second=join(dir,'while-ocr.md');writeFileSync(second,'# Available now\n\n慢识图期间新增资料仍可先保存。');const next=await runtime.submitImport({path:second,sourceId:'default',noEmbed:true,documentOcr:false});expect((await finish(Number(next.id.slice(5)))).status).toBe('completed');expect((await engine.getPage('while-ocr'))!.compiled_truth).toContain('慢识图期间');expect(embeddingCalls).toBe(vectorBefore);
  }finally{holdOcr=undefined;release();await runtime.adjustResourcePressure(false);}
  const [page]=await engine.executeRaw<{id:number;job:number}>("SELECT id,(frontmatter->>'document_ocr_task_id')::int job FROM pages WHERE slug='pipeline.docx' AND source_id='default'");expect((await finish(page.job)).status).toBe('completed');
  const until=Date.now()+60000;while(Date.now()<until){const [pending]=await engine.executeRaw<{n:number}>('SELECT count(*)::int n FROM content_chunks WHERE page_id=$1 AND embedding IS NULL',[page.id]);if(!pending.n)break;await Bun.sleep(100);}
  expect(calls-before).toBe(3);expect(embeddingCalls).toBeGreaterThan(vectorBefore);const sequence=events.slice(eventStart);expect(sequence.indexOf('embed')).toBeGreaterThan(sequence.lastIndexOf('ocr'));expect((await runtime.getRun(task.id))!.result).toMatchObject({ocrPending:0,ocrFailed:0});
},180000);

test('已有后台识图不阻塞快速维护，维护不发起实体提炼或向量化',async()=>{
  cpu=0.95;const chain=join(root,'chain');mkdirSync(chain);await engine.executeRaw("UPDATE sources SET config=config||'{\"syncEnabled\":false}'::jsonb WHERE id='default'");await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('chain','完整链路',$1,'{\"syncEnabled\":true,\"includeOffice\":true}'::jsonb)",[chain]);
  const original=await word('chain-input','保留这一份足够长的原始文字，图片文字补齐前不能进入后续提炼与向量化。'.repeat(8)),path=join(chain,'chain.docx');writeFileSync(path,readFileSync(original));unlinkSync(original);
  await engine.executeRaw("DELETE FROM config WHERE key='dream.entity_capture.pending.default'");await engine.setConfig('dream.entity_capture.enabled','true');await engine.setConfig('pricing.overrides',JSON.stringify({'custom-openai:isolated-office-ocr':{input:1,output:1},'custom-openai:deferred-embed':{input:1,output:0}}));
  const before=calls,vectorBefore=embeddingCalls,captureBefore=captureSources.filter(text=>text.includes('chain.docx')).length,result=await importOfficeFile(engine,path,'chain.docx',{...options,sourceId:'chain',deferredOcrVectors:false});
  const sync=await finish(Number((await runtime.submitSync()).id.slice(5)));expect(sync.status,JSON.stringify(sync.result)).toBe('completed');
  const maintenance=await runtime.submitDream({preset:'quick',sourceId:'chain'},'scheduled');expect((await finish(Number(maintenance.id.slice(5)))).status).toBe('completed');
  expect(calls).toBe(before);expect(embeddingCalls).toBe(vectorBefore);expect(captureSources.filter(text=>text.includes('chain.docx')).length).toBe(captureBefore);expect(await selectEntityCaptureCandidates(engine,'chain')).toHaveLength(0);
  const [queued]=await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM minion_jobs WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->>'sourceId'='chain'");expect(queued.n).toBe(1);
  cpu=0.1;expect((await finish(result.ocrTaskId!)).status).toBe('completed');expect(calls-before).toBe(3);expect(captureSources.filter(text=>text.includes('chain.docx')).length).toBe(captureBefore);
},180000);

test('维护产生的后台识图仍计入原任务总预算，提额继续后费用和向量合并到原任务',async()=>{
  await vectorConfiguration();
  await engine.setConfig('dream.entity_capture.enabled','false');await engine.setConfig('dream.task_budget_cny','0.000000001');const folder=join(root,'budget');mkdirSync(folder);await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('ocr-budget','识图费用验收',$1,'{\"includeOffice\":true}'::jsonb)",[folder]);
  const file=await word('budget-input');writeFileSync(join(folder,'budget.docx'),readFileSync(file));unlinkSync(file);cpu=0.1;const before=calls,vectorBefore=embeddingCalls,task=await runtime.submitDream({preset:'full',sourceId:'ocr-budget'},'scheduled');
  let childId=0;const until=Date.now()+60000;while(Date.now()<until){const [child]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1",[task.id.slice(5)]);if(child){childId=child.id;break;}await Bun.sleep(100);}expect(childId).toBeGreaterThan(0);
  const rejected=await finish(childId);expect(rejected.status).toBe('failed');expect((rejected.result as any).reason).toBe('task_budget');expect(calls).toBe(before);expect(embeddingCalls).toBe(vectorBefore);
  await engine.setConfig('dream.task_budget_cny','1');const raised=Date.now()+60000;while(Date.now()<raised){const [parent]=await engine.executeRaw<{cap:string}>("SELECT data->'taskBudget'->>'capCny' cap FROM minion_jobs WHERE id=$1",[Number(task.id.slice(5))]);if(Number(parent.cap)===1)break;await Bun.sleep(100);}
  await runtime.retry('task-'+childId);expect((await finish(childId)).status).toBe('completed');const done=await finish(Number(task.id.slice(5)));expect(done.status,JSON.stringify(done.result)).toBe('completed');expect((done.result as any).budget.calls).toBe(calls-before+embeddingCalls-vectorBefore);expect((done.result as any).budget.spentCny).toBeGreaterThan(0);expect((done.result as any).budget.capCny).toBe(1);
},180000);

test('停止维护同时停止它的识图子任务，重启保持停止，继续原维护才恢复',async()=>{
  await vectorConfiguration();await engine.setConfig('dream.task_budget_cny','1');
  cpu=0.95;const folder=join(root,'owned-stop');mkdirSync(folder);await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('owned-stop','停止验收',$1,'{\"includeOffice\":true}'::jsonb)",[folder]);const file=await word('owned-stop-input');writeFileSync(join(folder,'owned.docx'),readFileSync(file));unlinkSync(file);
  const before=calls,task=await runtime.submitDream({preset:'full',sourceId:'owned-stop'},'scheduled');let childId=0;const until=Date.now()+60000;while(Date.now()<until){const [child]=await engine.executeRaw<{id:number}>("SELECT id FROM minion_jobs WHERE name='pmbrain-document-ocr' AND data->'task'->'input'->'ocrOnly'->>'maintenanceOwnerId'=$1",[task.id.slice(5)]);if(child){childId=child.id;break;}await Bun.sleep(100);}expect(childId).toBeGreaterThan(0);
  await runtime.cancel(task.id);expect((await runtime.getRun('task-'+childId))!.status).toBe('cancelled');await runtime.close();await start();cpu=0.1;await Bun.sleep(300);expect((await runtime.getRun(task.id))!.status).toBe('cancelled');expect((await runtime.getRun('task-'+childId))!.status).toBe('cancelled');expect(calls).toBe(before);
  await runtime.retry(task.id);const done=await finish(Number(task.id.slice(5)));expect(done.status,JSON.stringify(done.result)).toBe('completed');expect(calls-before).toBe(3);expect((await runtime.getRun('task-'+childId))!.status).toBe('completed');
},180000);

test('识图汇总统计超过一百个文件，分页仍能找到早期失败项',async()=>{
  const before=await runtime.documentOcrOverview();
  await engine.executeRaw(`INSERT INTO minion_jobs(name,queue,status,data)
    SELECT 'pmbrain-document-ocr','pmbrain-sync-files',CASE WHEN n<=2 THEN 'failed' ELSE 'completed' END,
      jsonb_build_object('kind','document_ocr','trigger','scheduled','task',jsonb_build_object('type','import','input',jsonb_build_object('path','group-'||n||'.docx','sourceId','default','ocrOnly',jsonb_build_object('relativePath','group-'||n||'.docx'))))
    FROM generate_series(1,125) n`);
  const summary=await runtime.documentOcrOverview();
  expect(summary.total-before.total).toBe(125);expect(summary.failed-before.failed).toBe(2);expect(summary.completed-before.completed).toBe(123);
  expect((await runtime.listRuns()).some(run=>run.kind==='import_path')).toBe(true);
  let cursor:number|null=null;const found=new Map<string,string>();
  do{const page=await runtime.documentOcrRuns({before:cursor,limit:50});for(const run of page.rows){const name=run.product?.material?.name;if(name?.startsWith('group-'))found.set(name,run.status);}cursor=page.next;}while(cursor!==null&&found.size<125);
  expect(found.size).toBe(125);expect(found.get('group-1.docx')).toBe('failed');expect(found.get('group-2.docx')).toBe('failed');
},60000);
