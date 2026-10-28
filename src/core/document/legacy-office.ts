import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {basename,extname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import type {BrainEngine} from '../engine.ts';
import type {ChunkInput} from '../types.ts';
import type {ImportResult} from '../import-file.ts';
import {chunkText} from '../chunkers/recursive.ts';
import {resolveMaxChunkTokens} from '../embedding-input-limit.ts';
import {OCR_PROMPT_VERSION,OCR_RECEIPT_VERSION,type OcrReceipt} from '../ocr.ts';
import {extractImageOcrResult} from '../import-file.ts';
import {createDocumentOcr} from './ocr-cache.ts';
import {DocumentRuntime} from './resource-policy.ts';
import {snapshotDocument} from './file-snapshot.ts';
import {inspectLegacyChunks,type LegacyChunk} from './legacy-integrity.ts';
import {readDocumentChunkManifest} from './chunk-manifest.ts';
import {appendOoxmlImageOcr} from './ooxml-image-ocr.ts';
import {retryPdfOcrPages} from './parsers/pdf.ts';
import {renderStructuredDocument} from './markdown-renderer.ts';
import type {DocumentImportSummary,StructuredDocument} from './types.ts';
import {requestImportedEntityCapture} from '../pmbrain-adapters/entity-capture-request.ts';

export interface LegacyOfficeCandidate {id:number;slug:string;frontmatter:Record<string,any>;chunker_version:number;body_hash:string}
const bodyHash=(body:string)=>createHash('md5').update(body).digest('hex');
function summary(fm:Record<string,any>,attempted=0,reused=Number(fm.document_ocr_succeeded??0)):DocumentImportSummary{
  return {parser:fm.document_parser,structured:fm.document_structured===true,local:true,fallback:fm.document_parser_fallback,sections:Number(fm.document_sections??0),tables:Number(fm.document_tables??0),images:Number(fm.document_images??0),pagesNeedingOcr:Number(fm.document_pages_needing_ocr??0),ocrUsed:fm.document_ocr_used===true,ocrProvider:fm.document_ocr_provider,ocrAttempted:attempted,ocrSucceeded:Number(fm.document_ocr_succeeded??0),ocrFailed:Number(fm.document_ocr_failed??0),ocrSkipped:Number(fm.document_ocr_skipped??0),ocrWarnings:(fm.ocr_receipt?.failedItems??[]).map(String),ocrReused:reused};
}
function retryItem(value:string|number,pdf:boolean){
  if(pdf){const page=typeof value==='number'?value:Number(String(value).match(/^第\s*(\d+)\s*页[：:]/)?.[1]);return Number.isInteger(page)&&page>0?String(page):null;}
  return String(value).match(/^((?:word|ppt|xl)\/media\/[^:\n]+):\s*/)?.[1]??null;
}
export async function importLegacyOffice(engine:BrainEngine,candidate:LegacyOfficeCandidate,filePath:string,rawHash:string,opts:{sourceId?:string;noEmbed?:boolean;structured?:boolean;documentOcr:boolean;runtime:DocumentRuntime;validate:()=>Promise<void>}):Promise<ImportResult|null>{
  const sourceId=opts.sourceId??'default',runtime=opts.runtime,scope={sourceId},fm=candidate.frontmatter;
  const legacy=fm.document_legacy_reuse;
  if(legacy&&(legacy.version!==1||legacy.sourceHash!==rawHash))throw new Error('旧资料复用回执不匹配，已有内容保留');
  if(legacy&&legacy.bodyHash!==candidate.body_hash)throw new Error('旧资料正文在核验后已修改，已有内容保留，请核对后再导入');
  if(!/\.(?:doc|wps|ppt|xls)$/i.test(filePath)&&fm.document_structured!==(opts.structured!==false)&&!fm.document_parser_fallback)return null;
  const receipt=fm.ocr_receipt as OcrReceipt|undefined;
  if(opts.documentOcr&&(Number(fm.document_images??0)+Number(fm.document_pages_needing_ocr??0)>0||Number(receipt?.candidates??0)>0||Number(fm.document_ocr_failed??0)+Number(fm.document_ocr_skipped??0)>0)){
    if(!receipt||receipt.sourceHash!==rawHash||receipt.version!==OCR_RECEIPT_VERSION||receipt.promptVersion!==OCR_PROMPT_VERSION){
      if(Number(fm.document_ocr_succeeded??0)>0)return {slug:candidate.slug,status:'partial',chunks:0,error:'旧资料缺少可核验的识图回执，已有图片文字保留',documentSummary:summary(fm)};
      return null;
    }
    if(receipt.candidates>0&&receipt.attempted===0&&fm.document_ocr_deferred!==true)return null;
  }
  let state=await readDocumentChunkManifest(engine,candidate.id),created=0,attempted=0,reused=0;
  const pending=!!opts.documentOcr&&!!receipt&&(receipt.status!=='complete'||receipt.failed>0||Number(fm.document_ocr_skipped??0)>0);
  if(legacy?.verified&&state?.chunks===fm.document_chunk_count&&state.chunk_hash===fm.document_chunk_hash&&!pending){await opts.validate();return {slug:candidate.slug,status:'skipped',chunks:0,embeddingPending:(state?.pending??0)>0,documentSummary:summary(fm)};}
  let page=await engine.getPage(candidate.slug,scope);
  if(!page||page.id!==candidate.id||bodyHash(page.compiled_truth)!==candidate.body_hash)throw new Error('旧资料在核验期间已修改，请重新导入');
  runtime.assertText(Buffer.byteLength(page.compiled_truth));
  const readChunks=(tx:BrainEngine)=>tx.executeRaw<LegacyChunk>('SELECT chunk_index,chunk_text,chunk_source FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index',[candidate.id]);
  let chunks=await readChunks(engine);
  const lock=async(tx:BrainEngine)=>{
    const rows=await tx.executeRaw('SELECT id FROM pages WHERE id=$1 AND source_id=$2 AND md5(compiled_truth)=$3 AND frontmatter=$4::text::jsonb AND chunker_version>=0 AND deleted_at IS NULL FOR UPDATE',[page!.id,sourceId,bodyHash(page!.compiled_truth),JSON.stringify(page!.frontmatter)]);
    if(!rows.length)throw new Error('旧资料在核验期间已修改，请重新导入');
    const current=await readDocumentChunkManifest(tx,candidate.id);
    if(current?.chunks!==state?.chunks||current?.chunk_hash!==state?.chunk_hash)throw new Error('旧资料分块在核验期间已修改，请重新导入');
  };
  const seal=async(tx:BrainEngine,nextFm:Record<string,any>,body:string,verified=true)=>{
    const manifest=await readDocumentChunkManifest(tx,candidate.id);
    nextFm={...nextFm,document_chunk_count:manifest?.chunks??0,document_chunk_hash:manifest?.chunk_hash,document_legacy_reuse:{version:1,sourceHash:rawHash,bodyHash:bodyHash(body),verified}};
    await tx.executeRaw('UPDATE pages SET frontmatter=$2::text::jsonb WHERE id=$1',[candidate.id,JSON.stringify(nextFm)]);
    return {manifest,frontmatter:nextFm};
  };
  const merge=async(added:ChunkInput[],invalid:number[],nextFm:Record<string,any>,body:string,validate=opts.validate)=>{
    let offset=0;const changed=body!==page!.compiled_truth;
    do{
      await runtime.checkpoint(true);await validate();runtime.signal?.throwIfAborted();
      const batch=added.slice(offset,offset+runtime.plan.batchSize),first=offset===0,last=offset+batch.length>=added.length;
      const committed=await engine.transaction(async tx=>{
        await lock(tx);
        if(first&&invalid.length)await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=$1 AND chunk_index=ANY($2::int[])',[candidate.id,invalid]);
        if(first&&body!==page!.compiled_truth){await tx.createVersion(candidate.slug,scope);await tx.putPage(candidate.slug,{type:page!.type,title:page!.title,compiled_truth:body,timeline:page!.timeline,frontmatter:nextFm,chunker_version:candidate.chunker_version},scope);}
        if(batch.length)await tx.upsertChunks(candidate.slug,batch,{...scope,replaceExisting:false});
        const result=await seal(tx,nextFm,body,last);
        if(last&&(changed||added.length))await requestImportedEntityCapture(tx,sourceId,{slug:candidate.slug,type:page!.type,compiled_truth:body,frontmatter:result.frontmatter});
        return result;
      });
      state=committed.manifest;page={...page!,compiled_truth:body,frontmatter:committed.frontmatter};nextFm=committed.frontmatter;offset+=batch.length;
    }while(offset<added.length);
  };
  const inspection=await inspectLegacyChunks(page.compiled_truth,page.title,chunks,runtime);
  const repairs:ChunkInput[]=[];let nextIndex=chunks.reduce((index,chunk)=>Math.max(index,chunk.chunk_index),-1)+1;
  const repairTexts=new Set<string>();
  for(const text of inspection.missing)for(const child of chunkText(text,{maxTokens:resolveMaxChunkTokens()}))if(!repairTexts.has(child.text)&&!inspection.coveredText(child.text)){repairTexts.add(child.text);repairs.push({chunk_index:nextIndex++,chunk_text:child.text,chunk_source:'compiled_truth'});}
  await merge(repairs,inspection.invalid,page.frontmatter,page.compiled_truth);created+=repairs.length;
  if(!pending)return {slug:candidate.slug,status:repairs.length||inspection.invalid.length?'imported':'skipped',chunks:created,embeddingPending:(state?.pending??0)>0,documentSummary:summary(page.frontmatter)};
  const pdf=extname(filePath).toLowerCase()==='.pdf',items=new Map<string,string>();
  for(const warning of receipt!.failedItems??[]){const key=retryItem(warning,pdf);if(!key)return {slug:candidate.slug,status:'partial',chunks:created,error:'旧识图回执缺少可定位的失败项，已有内容保留',documentSummary:summary(page.frontmatter)};items.set(key,String(warning));}
  if(!items.size||items.size<Math.max(Number(receipt!.failed??0),Number(fm.document_ocr_failed??0))+Number(fm.document_ocr_skipped??0))return {slug:candidate.slug,status:'partial',chunks:created,error:'旧识图回执缺少可定位的失败项，已有内容保留',documentSummary:summary(page.frontmatter)};
  const directory=mkdtempSync(join(tmpdir(),'pmbrain-legacy-office-')),snapshotPath=join(directory,basename(filePath));
  try{
    const snapshot=await snapshotDocument(filePath,snapshotPath,runtime);if(snapshot.hash!==rawHash)throw new Error('资料在导入期间已修改，请重新导入');
    const recognize=createDocumentOcr(engine,sourceId,async(image,mime)=>{await snapshot.validate();await opts.validate();return extractImageOcrResult(engine,image,mime,{enabled:true});});
    let completed=0;process.stderr.write(`${JSON.stringify({event:'start',phase:'import.process.ocr',done:0,total:items.size,unit:pdf?'页':'张图片',stage:'补齐未完成的图片文字'})}\n`);
    const total=items.size;
    for(const key of [...items.keys()]){
      await runtime.checkpoint(true);const format=pdf?'pdf':extname(filePath).slice(1)==='xlsm'?'xlsx':extname(filePath).slice(1);
      let document:StructuredDocument={title:page.title,format:format as StructuredDocument['format'],sections:[],metadata:{parser:String(page.frontmatter.document_parser),local:true,structured:true,tableCount:0,imageCount:0,ocrUsed:false}};
      document=pdf?await retryPdfOcrPages(snapshotPath,[Number(key)],{runtime,ocrPage:recognize}):await appendOoxmlImageOcr(snapshotPath,document,{runtime,ocrPage:recognize,ocrItems:[key]});
      attempted+=document.metadata.ocrAttempted??0;reused+=document.metadata.ocrReused??0;
      if((document.metadata.ocrSucceeded??0)>0){
        const text=renderStructuredDocument(document),newBody:string=text?page.compiled_truth+'\n\n'+text:page.compiled_truth;
        runtime.assertText(Buffer.byteLength(newBody));const remaining=[...items].filter(([name])=>name!==key);
        const previousReceipt=page.frontmatter.ocr_receipt as OcrReceipt;
        const newReceipt={...previousReceipt,attempted:Math.min(Number(previousReceipt.candidates)||Infinity,Number(previousReceipt.attempted??0)+1),succeeded:Number(previousReceipt.succeeded??0)+1,failed:remaining.length,failedItems:remaining.map(([,warning])=>warning),reason:remaining[0]?.[1],status:remaining.length?'partial':'complete',processedAt:new Date().toISOString()};
        const nextFm:Record<string,any>={...page.frontmatter,ocr_receipt:newReceipt,document_ocr_used:true,document_ocr_attempted:newReceipt.attempted,document_ocr_succeeded:newReceipt.succeeded,document_ocr_failed:remaining.length,document_ocr_skipped:0,...(page.frontmatter.document_ocr_deferred?{document_ocr_deferred:remaining.length>0}:{})};
        const added=chunkText(text,{maxTokens:resolveMaxChunkTokens()}).map(child=>({chunk_index:nextIndex++,chunk_text:`Parent document: ${page!.title}\nSection: 图片文字补充\nLocator: ${pdf?'第 '+key+' 页':key}\n\n${child.text}`,chunk_source:'office_child' as const}));
        await merge(added,[],nextFm,newBody,async()=>{await snapshot.validate();await opts.validate();});created+=added.length;items.delete(key);
      }else{
        const warning=document.metadata.ocrWarnings?.[0];if(warning)items.set(key,warning);
        const previous=page.frontmatter.ocr_receipt as OcrReceipt,attempted=Math.min(Number(previous.candidates)||Infinity,Number(previous.attempted??0)+1);
        const nextFm={...page.frontmatter,document_ocr_attempted:attempted,document_ocr_failed:items.size,document_ocr_skipped:0,ocr_receipt:{...previous,attempted,failedItems:[...items.values()],failed:items.size,reason:[...items.values()][0],processedAt:new Date().toISOString(),status:'partial'}};
        await merge([],[],nextFm,page.compiled_truth,async()=>{await snapshot.validate();await opts.validate();});
      }
      completed++;process.stderr.write(`${JSON.stringify({event:'tick',phase:'import.process.ocr',done:completed,total,unit:pdf?'页':'张图片',stage:'补齐未完成的图片文字'})}\n`);
    }
  }finally{if(!resolve(directory).startsWith(resolve(tmpdir())+sep)||!basename(directory).startsWith('pmbrain-legacy-office-'))throw new Error('旧资料临时目录校验失败');rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
  return {slug:candidate.slug,status:items.size?'partial':created?'imported':'skipped',chunks:created,embeddingPending:(state?.pending??0)>0,...(items.size?{error:'图片识别仍有未完成项，已有正文保留：'+[...items.values()].join('；')}:{ }),documentSummary:summary(page.frontmatter,attempted,Number(fm.document_ocr_succeeded??0)+reused)};
}
