import {afterAll,beforeAll,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,statSync,utimesSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {createCanvas} from '@napi-rs/canvas';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import {configureGateway,resetGateway,__setChatTransportForTests} from '../src/core/ai/gateway';
import {importOfficeFile} from '../src/core/office-import';
import {runStructuredImport} from '../src/commands/import';
import {importOutcome} from '../shared/import-outcome';
import {taskCanRetry,taskStatus} from '../admin/src/product/task-presentation';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';
import {createDocumentOcr} from '../src/core/document/ocr-cache';
import {parseDocument} from '../src/core/document/document-import';
import {renderStructuredDocument} from '../src/core/document/markdown-renderer';
let root:string,engine:BrainEngine,calls=0,failAt=0,model='mimo:mimo-v2.6-flash',onOcr:(()=>Promise<void>)|undefined;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL'];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
function configured(){
  configureGateway({generative_enabled:true,chat_model:model,env:{MIMO_API_KEY:'isolated-test-only'}});
  __setChatTransportForTests(async()=>{
    calls++;const action=onOcr;onOcr=undefined;await action?.();const text=`OCR evidence ${calls}`;
    return {text,blocks:[{type:'text',text}],model,providerId:'mimo',usage:{input_tokens:2,output_tokens:2,cache_read_tokens:0,cache_creation_tokens:0},stopReason:failAt>0&&calls>=failAt?'length':'end'};
  });
}
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-office-recovery-'));
  for(const k of keys)delete process.env[k];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  const database=process.env.PMBRAIN_OFFICE_TEST_DATABASE_URL;if(database)assertSafeE2eDatabaseUrl(database);
  engine=database?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();
},90_000);
beforeEach(()=>{calls=0;failAt=0;model='mimo:mimo-v2.6-flash';onOcr=undefined;configured();});
afterAll(async()=>{
  __setChatTransportForTests(null);resetGateway();await engine?.disconnect();
  for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-office-recovery-'))throw new Error('临时目录校验失败');rmSync(root,{recursive:true,force:true});}
},60_000);
async function docx(path:string,text:string,images=1,imageSeed=text){
  const zip=new JSZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for(let i=0;i<images;i++){const canvas=createCanvas(32,32);canvas.getContext('2d').fillStyle='#'+createHash('sha256').update(imageSeed+':'+i).digest('hex').slice(0,6);canvas.getContext('2d').fillRect(0,0,32,32);zip.file(`word/media/image${i}.png`,canvas.toBuffer('image/png'));}
  writeFileSync(path,await zip.generateAsync({type:'uint8array'}));
}
async function fixture(name:string,text='Native source text',images=1){
  const dir=join(root,name);mkdirSync(dir);const sourceId='recover-'+name;const path=join(dir,'report.docx');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$2,$3)',[sourceId,name,dir]);await docx(path,text,images);
  return {dir,path,sourceId,options:{noEmbed:true,documentOcr:true,sourceId}};
}
test('导入中修改文件拒绝提交不匹配正文，原文件保留，重新导入得到当前内容',async()=>{
  const f=await fixture('snapshot','FIRST version');onOcr=()=>docx(f.path,'OTHER version',0);
  await expect(importOfficeFile(engine,f.path,'report.docx',f.options)).rejects.toThrow('导入期间');
  expect(await engine.getPage('report.docx',{sourceId:f.sourceId})).toBeNull();
  const current=readFileSync(f.path);const next=await importOfficeFile(engine,f.path,'report.docx',f.options);
  const page=await engine.getPage(next.slug,{sourceId:f.sourceId});expect(page!.compiled_truth).toContain('OTHER version');
  expect(page!.frontmatter.raw_sha256).toBe(createHash('sha256').update(current).digest('hex'));expect(readFileSync(f.path).equals(current)).toBe(true);
},60_000);
test('已有文件改成另一份已存内容时仍更新原路径，跨 Source 不合并',async()=>{
  const f=await fixture('duplicate','Document AAA',0);const other=join(f.dir,'second.docx');await docx(other,'Document BBB',0);
  await importOfficeFile(engine,f.path,'report.docx',f.options);await importOfficeFile(engine,other,'second.docx',f.options);copyFileSync(f.path,other);
  expect((await importOfficeFile(engine,other,'second.docx',f.options)).status).toBe('imported');
  expect((await engine.getPage('second.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('Document AAA');
  const outside=await fixture('duplicate-other','Independent source',0);
  expect((await importOfficeFile(engine,other,'second.docx',outside.options)).status).toBe('imported');
},60_000);
test('图片部分失败明确显示部分完成并可重试，重试只调用失败图片，第三次不再识图',async()=>{
  const f=await fixture('partial','Native body',2);failAt=2;
  const options={path:f.dir,noEmbed:true,fresh:true,includeOffice:true,documentOcr:true};
  const first=await runStructuredImport(engine,options,{sourceId:f.sourceId});
  expect(first.partialFiles).toBe(1);expect(importOutcome(first)!.outcome).toBe('partial');
  const run={id:'task-1',kind:'import_path',status:'failed',result:first} as any;
  expect(taskCanRetry(run)).toBe(true);expect(taskStatus(run)).toBe('部分完成');
  const prior=calls;failAt=0;const second=await runStructuredImport(engine,options,{sourceId:f.sourceId});
  expect(second.errors).toBe(0);expect(calls-prior).toBe(1);
  const after=calls;const third=await runStructuredImport(engine,options,{sourceId:f.sourceId});expect(third.unchanged).toBe(1);expect(calls).toBe(after);
  const page=await engine.getPage('report.docx',{sourceId:f.sourceId});expect(page!.compiled_truth).toContain('OCR evidence 1');expect(page!.compiled_truth).toContain(`OCR evidence ${prior+1}`);
},60_000);
test('显式关闭识图在单文件和目录入口均不调用模型',async()=>{
  const f=await fixture('disabled');await importOfficeFile(engine,f.path,'report.docx',{...f.options,documentOcr:false});expect(calls).toBe(0);
  const other=await fixture('disabled-folder');await runStructuredImport(engine,{path:other.dir,noEmbed:true,fresh:true,includeOffice:true,documentOcr:false},{sourceId:other.sourceId});expect(calls).toBe(0);
},60_000);
test('普通模型切换不重新识图，单纯改正文复用图片结果，强制重切分不重新付费',async()=>{
  const f=await fixture('model','First body');await importOfficeFile(engine,f.path,'report.docx',f.options);const prior=calls;
  model='mimo:mimo-v2.6-pro';configured();expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).status).toBe('skipped');expect(calls).toBe(prior);
  await docx(f.path,'Changed body',1,'First body');await importOfficeFile(engine,f.path,'report.docx',f.options);expect(calls).toBe(prior);
  await importOfficeFile(engine,f.path,'report.docx',{...f.options,forceRechunk:true});expect(calls).toBe(prior);
  expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('Changed body');
},60_000);
test('丢失中间或末尾分块均修补，保留图片识别结果',async()=>{
  const f=await fixture('holes','Native body',2);const first=await importOfficeFile(engine,f.path,'report.docx',f.options);const page=await engine.getPage(first.slug,{sourceId:f.sourceId});
  const [before]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1',[page!.id]);expect(before.n).toBeGreaterThan(1);
  const prior=calls;
  for(const position of ['max','min']){
    await engine.executeRaw(`DELETE FROM content_chunks WHERE page_id=$1 AND chunk_index=(SELECT ${position}(chunk_index) FROM content_chunks WHERE page_id=$1)`,[page!.id]);
    expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).status).toBe('imported');
    const [after]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1',[page!.id]);expect(after.n).toBe(before.n);expect(calls).toBe(prior);
  }
},60_000);
test('恢复入口重新核对内容，保留大小与时间的改动也不会漏导',async()=>{
  const f=await fixture('resume','FIRST content',0);const fixed=new Date('2026-01-01T00:00:00Z');utimesSync(f.path,fixed,fixed);await importOfficeFile(engine,f.path,'report.docx',f.options);const old=statSync(f.path);
  await docx(f.path,'OTHER content',0);utimesSync(f.path,fixed,fixed);expect(statSync(f.path).size).toBe(old.size);expect(statSync(f.path).mtimeMs).toBe(old.mtimeMs);
  const next=await runStructuredImport(engine,{path:f.dir,noEmbed:true,fresh:true,includeOffice:true},{sourceId:f.sourceId,runtime:{signal:new AbortController().signal,completedPaths:['report.docx'],onFile:async()=>{}}});
  expect(next.imported).toBe(1);expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('OTHER content');
},60_000);
test('OCR 缓存按 Source 隔离，识别失败不缓存为成功',async()=>{
  const first=await fixture('scope-a');failAt=1;expect((await importOfficeFile(engine,first.path,'report.docx',first.options)).status).toBe('partial');
  const second=await fixture('scope-b');const prior=calls;failAt=0;await importOfficeFile(engine,first.path,'report.docx',second.options);expect(calls).toBe(prior+1);
  await importOfficeFile(engine,first.path,'report.docx',first.options);expect(calls).toBe(prior+2);
},60_000);
test('已确认无文字的图片不反复识别，也不制造占位知识正文',async()=>{
  const f=await fixture('no-text','',1);let recognized=0;
  const ocr=createDocumentOcr(engine,f.sourceId,async()=>{recognized++;return {status:'success',text:'',model,code:'no_text'};});
  const first=await parseDocument(f.path,{ocrPage:ocr});const second=await parseDocument(f.path,{ocrPage:ocr});
  expect(renderStructuredDocument(first)).toBe('');expect(renderStructuredDocument(second)).toBe('');expect(recognized).toBe(1);
},60_000);
test('关闭识图仍保留可复用图片文字，重新开启只补未识别图片',async()=>{
  const f=await fixture('disabled-reuse','First body',2);failAt=2;await importOfficeFile(engine,f.path,'report.docx',f.options);const prior=calls;failAt=0;
  await docx(f.path,'Changed body',2,'First body');
  expect((await importOfficeFile(engine,f.path,'report.docx',{...f.options,documentOcr:false})).status).toBe('imported');expect(calls).toBe(prior);
  expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toContain('OCR evidence 1');
  await importOfficeFile(engine,f.path,'report.docx',f.options);expect(calls-prior).toBe(1);
},60_000);
test('重切分和缺块修补保留已有向量，只让缺失块等待补齐',async()=>{
  const f=await fixture('vectors','Native vector text',2);await importOfficeFile(engine,f.path,'report.docx',f.options);
  const page=await engine.getPage('report.docx',{sourceId:f.sourceId});
  const [column]=await engine.executeRaw<{dimensions:number}>("SELECT atttypmod::int AS dimensions FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  expect(column.dimensions).toBeGreaterThan(0);const vector=JSON.stringify(Array.from({length:column.dimensions},(_,i)=>i===0?1:0));
  await engine.executeRaw("UPDATE content_chunks SET embedding=$2::vector,model='fixture:original',embedded_at=now() WHERE page_id=$1",[page!.id,vector]);
  const read=()=>engine.executeRaw<{id:number;chunk_index:number;hash:string;model:string}>('SELECT id,chunk_index,md5(embedding::text) AS hash,model FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index',[page!.id]);
  const before=await read();await importOfficeFile(engine,f.path,'report.docx',{...f.options,forceRechunk:true});expect(await read()).toEqual(before);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND chunk_index=$2',[page!.id,before.at(-1)!.chunk_index]);
  await importOfficeFile(engine,f.path,'report.docx',f.options);const after=await read();expect(after.slice(0,-1)).toEqual(before.slice(0,-1));expect(after.at(-1)!.hash).toBeNull();
  expect((await importOfficeFile(engine,f.path,'report.docx',f.options)).embeddingPending).toBe(true);
},60_000);
test('旧资料缺少缓存时关闭识图复用已有图片文字，不覆盖正文',async()=>{
  const f=await fixture('legacy-cache');await importOfficeFile(engine,f.path,'report.docx',f.options);
  const before=await engine.getPage('report.docx',{sourceId:f.sourceId});
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'document.ocr.v1.%'");
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_chunk_count'-'document_chunk_hash' WHERE source_id=$1",[f.sourceId]);
  const reused=await importOfficeFile(engine,f.path,'report.docx',{...f.options,documentOcr:false});
  expect(reused.status).toBe('skipped');
  expect((await engine.getPage('report.docx',{sourceId:f.sourceId}))!.compiled_truth).toBe(before!.compiled_truth);
},60_000);
