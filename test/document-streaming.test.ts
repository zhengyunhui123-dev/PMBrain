import {test,expect,beforeAll,afterAll} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {DocumentRuntime,documentResourcePlan} from '../src/core/document/resource-policy';
import {DocumentZip} from '../src/core/document/zip-reader';
import {parseDocument} from '../src/core/document/document-import';
import {parseSpreadsheetDocument} from '../src/core/document/parsers/spreadsheet';
import {buildStructuredParentSections} from '../src/core/document/section-builder';

let root:string;
const gib=1024**3;
beforeAll(()=>{root=mkdtempSync(join(tmpdir(),'pmbrain-document-stream-'));});
afterAll(()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-document-stream-'))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});

test('资源充足时扩大批次，电脑繁忙或提交余量低时缩小，严重不足时等待',()=>{
  const fast=documentResourcePlan({bytes:gib,availableBytes:16*gib,totalBytes:32*gib,cpuBusyRatio:0.1});
  const busy=documentResourcePlan({bytes:gib,availableBytes:3*gib,totalBytes:8*gib,cpuBusyRatio:0.95});
  const commit=documentResourcePlan({bytes:gib,availableBytes:16*gib,totalBytes:32*gib,commitHeadroomBytes:128*1024**2});
  const low=documentResourcePlan({bytes:0,availableBytes:gib/2,totalBytes:32*gib});
  expect(low.maxTextBytes).toBe(8*1024**2);expect(fast.maxTextBytes).toBeGreaterThan(low.maxTextBytes);
  expect(fast.batchSize).toBeGreaterThan(busy.batchSize);expect(fast.rows).toBeGreaterThan(busy.rows);expect(fast.concurrency).toBeGreaterThan(busy.concurrency);expect(fast.maxFileBytes).toBeGreaterThan(busy.maxFileBytes);expect(busy.waiting).toBe(false);expect(commit.waiting).toBe(true);
});

test('等待资源时可取消，后续工作不会执行',async()=>{
  const controller=new AbortController(),runtime=new DocumentRuntime({signal:controller.signal,sample:()=>({bytes:gib,availableBytes:64*1024**2,totalBytes:8*gib})});
  setTimeout(()=>controller.abort(new Error('isolated cancel')),10);let stopped=false;
  try{await runtime.checkpoint(true);}catch{stopped=true;}expect(stopped).toBe(true);
});

test('共享字符串按需读取，数值和日期格式与原解析一致',async()=>{
  const path=join(root,'shared.xlsx'),book=XLSX.utils.book_new();
  const sheet=XLSX.utils.aoa_to_sheet([['编号','文本','日期'],...Array.from({length:600},(_,i)=>[i,`共享文字-${i}`,new Date(Date.UTC(2025,0,1+i))])],{cellDates:true});
  XLSX.utils.book_append_sheet(book,sheet,'日期');XLSX.writeFile(book,path,{bookSST:true});
  const before=parseSpreadsheetDocument(path),after=await parseDocument(path);
  const cells=(document:typeof after)=>document.sections.flatMap(section=>section.table?[section.table.headers,...section.table.rows].flat():[]).filter(Boolean);
  expect(cells(after)).toEqual(cells(before));expect(after.sections.at(-1)?.locator?.range).toContain('601');
});

test('CSV流式读取保留中文、逗号、换行和转义引号',async()=>{
  const path=join(root,'quoted.csv');writeFileSync(path,'\uFEFF标题,内容\r\n甲,"包含,逗号"\r\n乙,"第一行\n第二行"\r\n丙,"他说""可以"""\r\n');
  const document=await parseDocument(path);expect(document.sections[0].table).toMatchObject({headers:['标题','内容'],rows:[['甲','包含,逗号'],['乙','第一行 第二行'],['丙','他说"可以"']]});
});

test('ZIP内容损坏原样失败，不把坏内容导入',async()=>{
  const path=join(root,'bad.docx'),zip=new JSZip();zip.file('word/document.xml','<w:document><w:body><w:p><w:r><w:t>UNIQUE ORIGINAL</w:t></w:r></w:p></w:body></w:document>');
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});bytes[bytes.indexOf('UNIQUE ORIGINAL')]=88;writeFileSync(path,bytes);
  let error='';try{await parseDocument(path);}catch(cause){error=String(cause);}expect(error).toContain('校验失败');
});

test('解压额度不足在读取内容之前拒绝，避免压缩包膨胀',async()=>{
  const path=join(root,'expanded.docx'),zip=new JSZip();zip.file('word/document.xml','<w:document/>');
  const bytes=await zip.generateAsync({type:'nodebuffer'});const directory=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(0x70000000,directory+24);writeFileSync(path,bytes);
  let error='';try{await DocumentZip.open(path);}catch(cause){error=String(cause);}expect(error).toContain('解压内容超过');
});

test('文档末尾只有标题时仍纳入完整分块，不能依赖整页辅助索引',()=>{
  const parents=buildStructuredParentSections({title:'标题资料',format:'docx',sections:[{id:'first',type:'heading',heading:'FirstHeadingMarker',locator:{headingPath:['FirstHeadingMarker']}},{id:'tail',type:'heading',heading:'TailHeadingMarker',locator:{headingPath:['TailHeadingMarker']}}],metadata:{parser:'fixture',local:true,structured:true,tableCount:0,imageCount:0,ocrUsed:false}});
  expect(parents.map(parent=>parent.text).join('\n')).toContain('TailHeadingMarker');
});

test('PPT逐页检查累计正文额度，低内存时拒绝继续累积',async()=>{
  const path=join(root,'quota.pptx'),zip=new JSZip(),text='X'.repeat(5*1024**2);
  for(let page=1;page<=3;page++)zip.file(`ppt/slides/slide${page}.xml`,`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  writeFileSync(path,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  const runtime=new DocumentRuntime({sample:()=>({bytes:0,availableBytes:gib/2,totalBytes:32*gib})});
  await expect(parseDocument(path,{runtime})).rejects.toThrow('解析正文超过本机处理额度');
});

test('Office识图逐图检查累计正文，额度不足不再请求后续图片',async()=>{
  const path=join(root,'ocr-quota.docx'),zip=new JSZip();zip.file('word/document.xml','<w:document><w:body><w:p><w:r><w:t>原生正文</w:t></w:r></w:p></w:body></w:document>');
  for(let image=1;image<=3;image++)zip.file(`word/media/image${image}.png`,Buffer.from([image]));
  writeFileSync(path,await zip.generateAsync({type:'nodebuffer'}));let calls=0;
  const runtime=new DocumentRuntime({sample:()=>({bytes:0,availableBytes:gib/2,totalBytes:32*gib})});
  await expect(parseDocument(path,{runtime,ocrPage:async()=>{calls++;return {status:'success',text:'X'.repeat(5*1024**2),model:'fixture'};}})).rejects.toThrow('解析正文超过本机处理额度');
  expect(calls).toBe(2);
});
