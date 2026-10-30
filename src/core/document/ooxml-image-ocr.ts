import { extname } from 'node:path';
import {DocumentZip} from './zip-reader.ts';
import {renderDocumentSection} from './markdown-renderer.ts';
import type { DocumentParseOptions, StructuredDocument } from './types.ts';
import {settleOcrRequests} from './ocr-concurrency.ts';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

export async function appendOoxmlImageOcr(
  filePath: string,
  document: StructuredDocument,
  opts: DocumentParseOptions,
): Promise<StructuredDocument> {
  if (!opts.ocrPage&&!opts.deferOcr) return document;
  const prefix = document.format === 'docx' ? 'word/media/' : document.format === 'pptx' ? 'ppt/media/' : 'xl/media/';
  const zip = await DocumentZip.open(filePath,opts.runtime);
  try{
  const media = zip.names()
    .filter(name => !name.endsWith('/') && name.startsWith(prefix) && MIME_BY_EXTENSION[extname(name).toLowerCase()])
    .filter(name=>!opts.ocrItems||opts.ocrItems.includes(name)).sort();
  if(opts.ocrItems?.some(name=>!media.includes(name)))throw new Error('旧资料识图回执中的图片不存在，已有内容保留');
  if (media.length === 0) return document;
  if(opts.deferOcr){document.metadata.imageCount=Math.max(document.metadata.imageCount,media.length);document.metadata.ocrSkipped=media.length;document.metadata.ocrWarnings=media.map(name=>`${name}: 后台识图待完成`);return document;}

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const warnings: string[] = [];
  let model: string | undefined;
  let reused=0;
  let textBytes=document.sections.reduce((sum,section)=>sum+Buffer.byteLength(renderDocumentSection(section))+2,0);
  zip.runtime.assertText(textBytes);
  if(!opts.ocrItems)process.stderr.write(`${JSON.stringify({ event: 'start', phase: 'import.process.ocr', done: 0, total: media.length, unit: '张图片', stage: '图片识别' })}\n`);
  for(let offset=0;offset<media.length;){
    await zip.runtime.checkpoint(true);
    const count=zip.runtime.plan.concurrency>1?2:1,names=media.slice(offset,offset+count),start=offset;offset+=names.length;
    const images=[];
    for(const [index,name] of names.entries())images.push({page:start+index+1,image:await zip.buffer(name,32*1024**2),mime:MIME_BY_EXTENSION[extname(name).toLowerCase()]});
    const results=opts.ocrPage!.batch&&images.length>1?await opts.ocrPage!.batch(images):await settleOcrRequests(images.map(image=>opts.ocrPage!(image.page,image.image,image.mime)));
    if(results.length!==images.length)throw new Error('批量识图结果数量不匹配');
    for(const [localIndex,name] of names.entries()){
    const index=start+localIndex,result=results[localIndex];
    model ??= result.model ?? undefined;
    if(result.recognizedAt && (!document.metadata.ocrProcessedAt || result.recognizedAt>document.metadata.ocrProcessedAt))document.metadata.ocrProcessedAt=result.recognizedAt;
    if(result.reused)reused++;
    if (result.status === 'success') {
      textBytes+=Buffer.byteLength(result.text)+2;zip.runtime.assertText(textBytes);
      if(!result.reused)attempted++;
      succeeded++;
      if(result.text.trim())document.sections.push({
        id: `${document.format}-ocr-${index + 1}`,
        type: 'image',
        heading: `图片文字 ${index + 1}`,
        text: result.text,
        locator: {},
      });
    } else if (result.status === 'failed') {
      attempted++;
      failed++;
      warnings.push(`${name}: ${result.message ?? '图片识别失败'}`);
    } else {
      skipped++;
      if (result.message) warnings.push(`${name}: ${result.message}`);
    }
    if(!opts.ocrItems)process.stderr.write(`${JSON.stringify({ event: 'tick', phase: 'import.process.ocr', done: index + 1, total: media.length, unit: '张图片', stage: '图片识别' })}\n`);
    }
  }
  document.metadata.imageCount = Math.max(document.metadata.imageCount, media.length);
  document.metadata.ocrUsed = succeeded > 0;
  document.metadata.ocrProvider = model;
  document.metadata.ocrAttempted = attempted;
  document.metadata.ocrSucceeded = succeeded;
  document.metadata.ocrFailed = failed;
  document.metadata.ocrSkipped = skipped;
  document.metadata.ocrWarnings = warnings;
  document.metadata.ocrReused = reused;
  return document;
  }finally{await zip.close();}
}
