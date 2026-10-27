import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';
import {resetPgliteState} from './helpers/reset-pglite';
import {importOfficeFile} from '../src/core/office-import';
import {configPath} from '../src/core/config';
import {DocumentRuntime} from '../src/core/document/resource-policy';
import {readContentChunksEmbeddingDim} from '../src/core/embedding-dim-check';
import {BOUNDED_PAGE_SEARCH_SQL} from '../src/core/pmbrain-adapters/bounded-search-schema';
import {MIGRATIONS} from '../src/core/migrate';

const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
let root:string,engine:BrainEngine,table:string;
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-large-office-'));mkdirSync(join(root,'.pmbrain'));
  for(const key of keys)delete process.env[key];process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  writeFileSync(configPath(),JSON.stringify({engine:database?'postgres':'pglite',...(database?{database_url:database}:{database_path:join(root,'database')}),model_usage:{embedding_enabled:false,generative_enabled:false}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  engine=(database?new PostgresEngine():new WorkerPgliteEngine()) as unknown as BrainEngine;
  await engine.connect(database?{database_url:database}:{database_path:join(root,'database')});await engine.initSchema();
  if(database)await resetPgliteState(engine as any);
},90000);
afterAll(async()=>{
  await engine?.disconnect();for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-large-office-'))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
},60000);

test('大量不同词汇的正文可保存，辅助全文索引不超过数据库上限',async()=>{
  const content=Array.from({length:50000},(_,i)=>createHash('md5').update(String(i)).digest('hex')).join(' ');
  await engine.putPage('index-limit',{title:'索引大小验收',type:'note',compiled_truth:content},{sourceId:'default'});
  const [row]=await engine.executeRaw<{bytes:number}>('SELECT pg_column_size(search_vector)::int AS bytes FROM pages WHERE slug=$1 AND source_id=$2',['index-limit','default']);
  expect(row.bytes).toBeLessThan(1048575);expect((await engine.getPage('index-limit'))!.compiled_truth).toBe(content);
},60000);

test('超过旧50MB门槛的Word按内容项解析，原文件不改动',async()=>{
  const path=join(root,'large.docx'),zip=new JSZip();
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OversizedWordTailToken 原文件应当保留</w:t></w:r></w:p></w:body></w:document>');
  zip.file('word/media/unused.bin',Readable.from((function*(){for(let i=0;i<52;i++)yield Buffer.alloc(1024**2,i);})()));
  await pipeline(zip.generateNodeStream({streamFiles:true,compression:'STORE'}),createWriteStream(path));
  const before=createHash('sha256').update(readFileSync(path)).digest('hex');
  const result=await importOfficeFile(engine,path,'large.docx',{noEmbed:true,documentOcr:false});
  expect(result.status,result.error).toBe('imported');expect((await engine.getPage(result.slug))!.compiled_truth).toContain('OversizedWordTailToken');
  expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
},120000);

async function spreadsheet(){
  const path=join(root,'large.xlsx'),zip=new JSZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="大表" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml',Readable.from((function*(){
    yield '<worksheet><sheetData>';
    for(let i=0;i<6000;i++)yield `<row r="${i+1}"><c r="A${i+1}" t="inlineStr"><is><t>${i===0?'LargeSheetFirstToken':i===3000?'LargeSheetMiddleToken':i===5999?'LargeSheetTailToken':'Row'+i} ${'用于核验大表完整内容与资源控制。'.repeat(30)}</t></is></c></row>`;
    yield '</sheetData></worksheet>';
  })()));
  await pipeline(zip.generateNodeStream({streamFiles:true,compression:'DEFLATE'}),createWriteStream(path));return path;
}

test('解析正文超过5MB的Excel分段写入，首中尾可检索，重复导入不改版本',async()=>{
  table=await spreadsheet();const original=readFileSync(table);
  const result=await importOfficeFile(engine,table,'large.xlsx',{noEmbed:true,documentOcr:false});
  expect(result.status,result.error).toBe('imported');const page=(await engine.getPage(result.slug))!;
  expect(Buffer.byteLength(page.compiled_truth)).toBeGreaterThan(5_000_000);
  for(const term of ['LargeSheetFirstToken','LargeSheetMiddleToken','LargeSheetTailToken'])expect((await engine.searchKeyword(term,{sourceId:'default',limit:3})).some(row=>row.slug===result.slug)).toBe(true);
  const repeated=await importOfficeFile(engine,table,'large.xlsx',{noEmbed:true,documentOcr:false});expect(repeated.status).toBe('skipped');
  expect((await engine.getPage(result.slug))!.content_hash).toBe(page.content_hash);expect(String((await engine.getPage(result.slug))!.updated_at)).toBe(String(page.updated_at));expect(readFileSync(table)).toEqual(original);
},240000);

test('索引函数升级可重复执行，旧页正文、分块、向量和时间保持不变',async()=>{
  await engine.putPage('legacy-guard',{title:'旧资料保护',type:'note',compiled_truth:'Existing source must remain unchanged'},{sourceId:'default'});
  const dimensions=await readContentChunksEmbeddingDim(engine);expect(dimensions.exists).toBe(true);
  await engine.upsertChunks('legacy-guard',[{chunk_index:0,chunk_text:'Existing source must remain unchanged',chunk_source:'compiled_truth',embedding:new Float32Array(dimensions.dims??3),model:'isolated:existing'}],{sourceId:'default'});
  const snapshot=()=>engine.executeRaw('SELECT p.content_hash,p.compiled_truth,p.updated_at,c.id,c.chunk_text,c.embedding::text AS vector,c.model,c.embedded_at FROM pages p JOIN content_chunks c ON c.page_id=p.id WHERE p.slug=$1 AND p.source_id=$2',['legacy-guard','default']);
  const before=await snapshot();expect(MIGRATIONS.find(migration=>migration.version===138)?.sql).not.toMatch(/\bUPDATE\s+pages\b/i);
  await engine.runMigration(138,BOUNDED_PAGE_SEARCH_SQL);await engine.runMigration(138,BOUNDED_PAGE_SEARCH_SQL);expect(await snapshot()).toEqual(before);
},60000);

test('分批中断后保留已提交段，重开后只补缺失分块，Source独立',async()=>{
  table??=await spreadsheet();await engine.executeRaw("INSERT INTO sources(id,name) VALUES('large-resume','大表恢复')");
  let written=0;const interrupted=new Proxy(engine,{get(target,key){
    if(key==='transaction')return (fn:(tx:BrainEngine)=>Promise<unknown>)=>target.transaction(tx=>fn(new Proxy(tx,{get(inner,method){
      if(method==='upsertChunks')return async(...args:Parameters<BrainEngine['upsertChunks']>)=>{if(written++===1)throw new Error('isolated interruption');return inner.upsertChunks(...args);};
      const value=Reflect.get(inner,method);return typeof value==='function'?value.bind(inner):value;
    }})));
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as BrainEngine;
  let failure:unknown;try{await importOfficeFile(interrupted,table,'large.xlsx',{sourceId:'large-resume',noEmbed:true,documentOcr:false,runtime:new DocumentRuntime({sample:()=>({bytes:1024**3,availableBytes:12*1024**3,totalBytes:32*1024**3,cpuBusyRatio:0.1})})});}catch(error){failure=error;}
  expect(String(failure)).toContain('isolated interruption');
  const [prior]=await engine.executeRaw<{count:number}>('SELECT count(*)::int AS count FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1',['large-resume']);expect(prior.count).toBeGreaterThan(0);
  const before=await engine.executeRaw('SELECT c.id,c.chunk_text,c.model,c.embedded_at FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 ORDER BY c.chunk_index',['large-resume']);
  const done=await importOfficeFile(engine,table,'large.xlsx',{sourceId:'large-resume',noEmbed:true,documentOcr:false,runtime:new DocumentRuntime({sample:()=>({bytes:1024**3,availableBytes:3*1024**3,totalBytes:8*1024**3,cpuBusyRatio:0.95})})});expect(done.status,done.error).toBe('imported');
  const after=await engine.executeRaw('SELECT c.id,c.chunk_text,c.model,c.embedded_at FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 ORDER BY c.chunk_index LIMIT $2',['large-resume',prior.count]);expect(after).toEqual(before);
  expect((await engine.searchKeyword('LargeSheetTailToken',{sourceId:'large-resume',limit:3})).some(row=>row.slug===done.slug)).toBe(true);
  const [versions]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1',['large-resume']);expect(versions.n).toBe(0);
},240000);
