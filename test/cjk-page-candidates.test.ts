import {afterAll,beforeAll,expect,test} from 'bun:test';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
let engine:PGLiteEngine;
beforeAll(async()=>{engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();},60_000);
afterAll(async()=>{await engine.disconnect();});
test('a many-chunk Chinese book cannot crowd other matching pages out of page results',async()=>{
 await engine.putPage('books/long',{type:'note',title:'星海长篇',compiled_truth:'星海'.repeat(150)});
 await engine.upsertChunks('books/long',Array.from({length:100},(_,i)=>({chunk_index:i,chunk_source:'compiled_truth' as const,chunk_text:'星海'.repeat(10)})));
 for(let i=0;i<12;i++){
  const slug='notes/short-'+i;
  await engine.putPage(slug,{type:'note',title:'资料'+i,compiled_truth:'星海资料'});
  await engine.upsertChunks(slug,[{chunk_index:0,chunk_source:'compiled_truth',chunk_text:'星海资料'}]);
 }
 await engine.putPage('notes/body-only',{type:'note',title:'正文尾部',compiled_truth:'重要星海附录'});
 await engine.upsertChunks('notes/body-only',[{chunk_index:0,chunk_source:'compiled_truth',chunk_text:'前半段摘要'}]);
 const hits=await engine.searchKeyword('星海',{limit:20});
 expect(hits).toHaveLength(14);expect(hits[0].slug).toBe('books/long');
 expect(hits.map(r=>r.slug)).toContain('notes/body-only');
 const filtered=await engine.searchKeyword('星海',{limit:20,sourceId:'default'});
 expect(filtered.map(r=>r.slug)).toEqual(hits.map(r=>r.slug));
},60_000);

test('日期、正文和同名资料按各自来源命中',async()=>{
 await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('cjk-other','cjk-other') ON CONFLICT DO NOTHING");
 for(const sourceId of ['default','cjk-other']){
  await engine.putPage('projects/cjk-scope',{type:'project',title:'海岸项目',compiled_truth:'海岸项目会议 10月26日'}, {sourceId});
  await engine.upsertChunks('projects/cjk-scope',[{chunk_index:0,chunk_source:'compiled_truth',chunk_text:'海岸项目会议 10月26日'}],{sourceId});
 }
 await engine.putPage('notes/body-cjk-only',{type:'note',title:'会议摘录',compiled_truth:'独特正文线索在附件之后'});
 await engine.upsertChunks('notes/body-cjk-only',[{chunk_index:0,chunk_source:'compiled_truth',chunk_text:'前半段摘要'}]);
 const scope=await engine.searchKeyword('海岸项目 10月26日',{sourceId:'cjk-other',limit:20});
 expect(scope.map(hit=>[hit.source_id,hit.slug])).toEqual([['cjk-other','projects/cjk-scope']]);
 expect((await engine.searchKeyword('独特正文线索',{sourceId:'default',limit:20})).map(hit=>hit.slug)).toContain('notes/body-cjk-only');
 expect(await engine.searchKeyword('独特正文线索',{sourceId:'cjk-other',limit:20})).toHaveLength(0);
},60_000);
