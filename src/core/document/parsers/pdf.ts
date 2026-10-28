import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { normalizeDocumentText } from '../normalize.ts';
import type { DocumentParseOptions, DocumentSection, StructuredDocument } from '../types.ts';
import { markdownToSections } from './markdown-sections.ts';
import { pdfRuntimeOptions } from '../pdf-runtime.ts';
import {DocumentRuntime} from '../resource-policy.ts';
import {renderDocumentSection} from '../markdown-renderer.ts';

async function parseWithPdfParse(buffer: Buffer, title: string, fallback?: string,runtime=new DocumentRuntime()): Promise<StructuredDocument> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer, ...pdfRuntimeOptions() });
  try {
    const info=await parser.getInfo();
    const sections: DocumentSection[] = [];
    let bytes=0;
    for(let page=1;page<=info.total;page++){
      await runtime.checkpoint(true);
      const result=await parser.getText({partial:[page],pageJoiner:''});
      const text = normalizeDocumentText(result.pages.map(item=>item.text).join('\n'));
      bytes+=Buffer.byteLength(text);runtime.assertText(bytes);
      if (text) sections.push(...markdownToSections(text, { page }, `pdf-fallback-p${page}`));
    }
    return {
      title,
      format: 'pdf',
      sections,
      metadata: {
        parser: 'pdf-parse',
        local: true,
        structured: false,
        fallback,
        pageCount: info.total,
        tableCount: 0,
        imageCount: 0,
        ocrUsed: false,
      },
    };
  } finally {
    await parser.destroy();
  }
}
async function addOcrPages(
  buffer: Buffer,
  document: StructuredDocument,
  pagesNeedingOcr: number[],
  ocrPage: NonNullable<DocumentParseOptions['ocrPage']>,
  runtime=new DocumentRuntime(),
  progress=true,
): Promise<void> {
  if (pagesNeedingOcr.length === 0) return;
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer, ...pdfRuntimeOptions() });
  try {
    let completed=0,textBytes=document.sections.reduce((sum,section)=>sum+Buffer.byteLength(renderDocumentSection(section))+2,0);
    runtime.assertText(textBytes);
    for(const requestedPage of pagesNeedingOcr){
    await runtime.checkpoint(true);
    const screenshots = await parser.getScreenshot({
      partial: [requestedPage],
      desiredWidth: 1800,
      imageBuffer: true,
    });
    const pages = screenshots.pages.filter(screenshot => screenshot.data?.length);
    if(progress&&!completed)process.stderr.write(`${JSON.stringify({ event: 'start', phase: 'import.process.ocr', done: 0, total: pagesNeedingOcr.length, unit: '页', stage: '图片识别' })}\n`);
    for (const [index, screenshot] of pages.entries()) {
      if (!screenshot.data?.length) continue;
      const result = await ocrPage(screenshot.pageNumber, Buffer.from(screenshot.data), 'image/png');
      if (result.status !== 'skipped'&&!result.reused) document.metadata.ocrAttempted = (document.metadata.ocrAttempted ?? 0) + 1;
      if(result.reused)document.metadata.ocrReused=(document.metadata.ocrReused??0)+1;
      if(result.recognizedAt && (!document.metadata.ocrProcessedAt || result.recognizedAt>document.metadata.ocrProcessedAt))document.metadata.ocrProcessedAt=result.recognizedAt;
      if (result.status === 'success') {
        const text = normalizeDocumentText(result.text);
        textBytes+=Buffer.byteLength(text)+2;runtime.assertText(textBytes);
        if (text) document.sections.push(...markdownToSections(text, { page: screenshot.pageNumber }, `pdf-ocr-p${screenshot.pageNumber}`));
        document.metadata.ocrUsed = true;
        document.metadata.ocrSucceeded = (document.metadata.ocrSucceeded ?? 0) + 1;
      } else if (result.status === 'failed') {
        document.metadata.ocrFailed = (document.metadata.ocrFailed ?? 0) + 1;
      } else {
        document.metadata.ocrSkipped = (document.metadata.ocrSkipped ?? 0) + 1;
      }
      if (result.model) document.metadata.ocrProvider = result.model;
      if (result.message) document.metadata.ocrWarnings = [...(document.metadata.ocrWarnings ?? []), `第 ${screenshot.pageNumber} 页：${result.message}`];
      completed++;if(progress)process.stderr.write(`${JSON.stringify({ event: 'tick', phase: 'import.process.ocr', done: completed, total: pagesNeedingOcr.length, unit: '页', stage: '图片识别' })}\n`);
    }
    }
  } finally {
    await parser.destroy();
  }
}

export async function retryPdfOcrPages(filePath:string,pages:number[],opts:DocumentParseOptions):Promise<StructuredDocument>{
  const runtime=opts.runtime??new DocumentRuntime();await runtime.checkpoint(true);
  const buffer=readFileSync(filePath),{classifyPdf}=await import('@firecrawl/pdf-inspector');
  const total=classifyPdf(buffer).pageCount;
  if(pages.some(page=>!Number.isInteger(page)||page<1||page>total))throw new Error('旧资料识图回执中的页码不存在，已有内容保留');
  const document:StructuredDocument={title:basename(filePath,extname(filePath)),format:'pdf',sections:[],metadata:{parser:'@firecrawl/pdf-inspector@1.12.0',local:true,structured:true,pageCount:total,tableCount:0,imageCount:pages.length,pagesNeedingOcr:pages,ocrUsed:false}};
  if(opts.ocrPage)await addOcrPages(buffer,document,pages,opts.ocrPage,runtime,false);
  return document;
}

export async function parsePdfDocument(filePath: string, opts: DocumentParseOptions = {}): Promise<StructuredDocument> {
  const runtime=opts.runtime??new DocumentRuntime();await runtime.checkpoint(true);
  const buffer = readFileSync(filePath);
  const title = basename(filePath, extname(filePath));
  if (opts.structured === false&&!opts.deferOcr) return parseWithPdfParse(buffer, title,undefined,runtime);

  let processingOcr=false;
  try {
    const { classifyPdf,extractPagesMarkdown, extractTextWithPositions } = await import('@firecrawl/pdf-inspector');
    const classification=classifyPdf(buffer);
    const sections:DocumentSection[]=[];const pagesWithTables:number[]=[],pagesNeedingOcr:number[]=[];
    let textBytes=0;
    for(let page=0;page<classification.pageCount;){
      await runtime.checkpoint(true);
      const count=Math.min(Math.max(1,Math.floor(runtime.plan.rows/12)),16,classification.pageCount-page);
      const requested=Array.from({length:count},(_,i)=>page+i);
      const extracted=extractPagesMarkdown(buffer,requested);
      for(const item of extracted.pages){textBytes+=Buffer.byteLength(item.markdown);runtime.assertText(textBytes);sections.push(...markdownToSections(item.markdown,{page:item.page+1},`pdf-p${item.page+1}`));}
      pagesWithTables.push(...extracted.pagesWithTables);pagesNeedingOcr.push(...extracted.pagesNeedingOcr);
      if(opts.ocrPage||opts.deferOcr){
        const items=extractTextWithPositions(buffer,requested.map(page=>page+1));
        for(const image of items)if(image.itemType==='Image'&&image.width>=72&&image.height>=72&&!pagesNeedingOcr.includes(image.page)&&!items.some(text=>text.page===image.page&&text.itemType==='Text'&&text.text.trim()&&text.x+text.width/2>=image.x&&text.x+text.width/2<=image.x+image.width&&text.y+text.height/2>=image.y&&text.y+text.height/2<=image.y+image.height))pagesNeedingOcr.push(image.page);
      }
      page+=count;
    }
    const document: StructuredDocument = {
      title,
      format: 'pdf',
      sections,
      metadata: {
        parser: '@firecrawl/pdf-inspector@1.12.0',
        local: true,
        structured: true,
        pageCount: classification.pageCount,
        tableCount: pagesWithTables.length,
        imageCount: pagesNeedingOcr.length,
        pagesNeedingOcr: [...new Set(pagesNeedingOcr)].sort((a,b)=>a-b),
        ocrUsed: false,
      },
    };
    if(opts.deferOcr){document.metadata.ocrSkipped=document.metadata.pagesNeedingOcr?.length??0;document.metadata.ocrWarnings=(document.metadata.pagesNeedingOcr??[]).map(page=>`第 ${page} 页：后台识图待完成`);}
    else if (opts.ocrPage) {
      processingOcr=true;
      await addOcrPages(buffer, document, document.metadata.pagesNeedingOcr??[], opts.ocrPage,runtime);
      processingOcr=false;
    }
    if (document.sections.length === 0) {
      const fallback = await parseWithPdfParse(buffer, title, 'pdf-inspector returned no extractable text',runtime);
      return opts.deferOcr?document:fallback.sections.length > 0 || !opts.ocrPage ? fallback : document;
    }
    return document;
  } catch (error) {
    if(processingOcr||runtime.signal?.aborted||String(error).includes('资源保护：'))throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = await parseWithPdfParse(buffer, title, `pdf-inspector failed: ${reason}`,runtime);
    if ((opts.ocrPage||opts.deferOcr) && fallback.sections.length === 0 && (fallback.metadata.pageCount ?? 0) > 0) {
      const pages = Array.from({ length: fallback.metadata.pageCount ?? 0 }, (_, index) => index + 1);
      fallback.metadata.pagesNeedingOcr = pages;
      fallback.metadata.imageCount = pages.length;
      if(opts.deferOcr){fallback.metadata.ocrSkipped=pages.length;fallback.metadata.ocrWarnings=pages.map(page=>`第 ${page} 页：后台识图待完成`);}
      else if(opts.ocrPage)await addOcrPages(buffer, fallback, pages, opts.ocrPage,runtime);
    }
    return fallback;
  }
}
