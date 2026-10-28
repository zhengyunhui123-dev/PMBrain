import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {configPath} from '../src/core/config';
import {reloadLiveGateway} from '../src/core/ai/reload-live-gateway';
import {resetGateway} from '../src/core/ai/gateway';
import {importOfficeFile} from '../src/core/office-import';
let root:string,engine:BrainEngine,server:ReturnType<typeof Bun.serve>,path:string,reject=false;const requests:string[][]=[];
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL','PMBRAIN_EMBEDDING_MODEL','GBRAIN_EMBEDDING_MODEL','PMBRAIN_EMBEDDING_DIMENSIONS','GBRAIN_EMBEDDING_DIMENSIONS'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]])),dimensions=1280,model='custom-openai:legacy-inline';
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-legacy-inline-'));for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;mkdirSync(join(root,'.pmbrain'));
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json() as {input:string|string[]};const texts=Array.isArray(body.input)?body.input:[body.input];requests.push(texts);if(reject)return Response.json({error:{message:'fixture native embedding rejected'}},{status:400});return Response.json({data:texts.map((_,index)=>({index,embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)})),model:'legacy-inline',usage:{prompt_tokens:texts.length,total_tokens:texts.length}});}});
  writeFileSync(configPath(),JSON.stringify({engine:'pglite',database_path:join(root,'database'),embedding_model:model,embedding_dimensions:dimensions,custom_openai_api_key:'isolated-only',provider_base_urls:{'custom-openai':server.url.origin+'/v1'},model_usage:{generative_enabled:false,embedding_enabled:true}}));
  engine=new WorkerPgliteEngine() as unknown as BrainEngine;await engine.connect({database_path:join(root,'database')});await engine.initSchema();await reloadLiveGateway(engine);
  for(const sourceId of ['inline-target','inline-other']){
    const dir=join(root,sourceId);mkdirSync(dir);await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[sourceId,dir]);const file=join(dir,'report.docx'),zip=new JSZip();
    zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[1,2,3].map(index=>`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Section ${index}</w:t></w:r></w:p><w:p><w:r><w:t>${sourceId} NativeSourceMarker${index}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);writeFileSync(file,await zip.generateAsync({type:'nodebuffer'}));await importOfficeFile(engine,file,'report.docx',{sourceId,noEmbed:true,documentOcr:false});if(sourceId==='inline-target')path=file;
  }
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'document_chunk_count'-'document_chunk_hash' WHERE source_id='inline-target'");
  const vector=Array(dimensions).fill(0);vector[0]=1;await engine.executeRaw("UPDATE content_chunks SET embedding=$1::vector,model=$2,embedded_at='2026-01-01'::timestamptz WHERE id=(SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='inline-target' ORDER BY c.chunk_index LIMIT 1)",[JSON.stringify(vector),model]);
},90000);
afterAll(async()=>{
  await engine?.disconnect();server?.stop(true);resetGateway();for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-legacy-inline-'))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
},60000);
test('CLI直接导入旧资料仍补缺失向量，只处理目标 Source 并保留已有向量',async()=>{
  const [before]=await engine.executeRaw("SELECT c.id,c.embedding::text AS vector,c.model,c.embedded_at::text AS at FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='inline-target' ORDER BY c.chunk_index LIMIT 1"),body=(await engine.getPage('report.docx',{sourceId:'inline-target'}))!.compiled_truth;
  const result=await importOfficeFile(engine,path,'report.docx',{sourceId:'inline-target',noEmbed:false,documentOcr:false});expect(result.status).toBe('imported');expect(result.embeddingPending).toBe(false);expect(requests.length).toBeGreaterThan(0);expect(requests.flat().some(text=>text.includes('inline-other'))).toBe(false);
  const [after]=await engine.executeRaw('SELECT id,embedding::text AS vector,model,embedded_at::text AS at FROM content_chunks WHERE id=$1',[(before as any).id]);expect(after).toEqual(before);expect((await engine.getPage('report.docx',{sourceId:'inline-target'}))!.compiled_truth).toBe(body);
  const [other]=await engine.executeRaw<{count:number}>("SELECT count(*)::int AS count FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='inline-other' AND c.embedding IS NOT NULL");expect(other.count).toBe(0);
  const count=requests.length;expect((await importOfficeFile(engine,path,'report.docx',{sourceId:'inline-target',noEmbed:false,documentOcr:false})).status).toBe('skipped');expect(requests.length).toBe(count);
},60000);
test('CLI补向量失败保留原错误及已有正文，不空报成功',async()=>{
  const body=(await engine.getPage('report.docx',{sourceId:'inline-target'}))!.compiled_truth;await engine.executeRaw("UPDATE content_chunks SET embedding=NULL,model=NULL,embedded_at=NULL WHERE id=(SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='inline-target' ORDER BY c.chunk_index DESC LIMIT 1)");reject=true;
  const result=await importOfficeFile(engine,path,'report.docx',{sourceId:'inline-target',noEmbed:false,documentOcr:false});expect(result.status).toBe('partial');expect(result.error).toContain('fixture native embedding rejected');expect(result.embeddingPending).toBe(true);expect((await engine.getPage('report.docx',{sourceId:'inline-target'}))!.compiled_truth).toBe(body);
},60000);
