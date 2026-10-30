import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCanvas} from '@napi-rs/canvas';
import {parsePdfDocument,retryPdfOcrPages} from '../src/core/document/parsers/pdf';
import {renderStructuredDocument} from '../src/core/document/markdown-renderer';
import {DocumentRuntime} from '../src/core/document/resource-policy';

let root:string;let path:string;let plainPath:string;
beforeAll(()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-pdf-ocr-'));path=join(root,'mixed.pdf');plainPath=join(root,'plain.pdf');
  const canvas=createCanvas(512,512);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,512,512);ctx.fillStyle='black';ctx.fillText('image evidence',25,25);
  const image=canvas.toBuffer('image/jpeg');
  const streams=['q 500 0 0 500 40 120 cm /Im1 Do Q','BT /F1 12 Tf 40 760 Td (Native header) Tj ET q 500 0 0 500 40 120 cm /Im1 Do Q','BT /F1 12 Tf 60 400 Td (Searchable image text already present) Tj ET q 500 0 0 500 40 120 cm /Im1 Do Q','BT /F1 12 Tf 40 760 Td (Native document with a small logo) Tj ET q 20 0 0 20 40 600 cm /Im1 Do Q'];
  const objects:Buffer[]=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>')];
  for(let i=0;i<4;i++){objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 11 0 R >> /XObject << /Im1 12 0 R >> >> /Contents ${4+i*2} 0 R >>`));objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(streams[i])} >>\nstream\n${streams[i]}\nendstream`));}
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 512 /Height 512 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]));
  const parts=[Buffer.from('%PDF-1.4\n')];const offsets=[0];let length=parts[0].length;
  objects.forEach((object,i)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);parts.push(part);length+=part.length;});
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));writeFileSync(path,Buffer.concat(parts));
  const plainStream='BT /F1 14 Tf 40 760 Td (Native searchable PDF text) Tj ET';
  const plainObjects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(plainStream)} >>\nstream\n${plainStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const plainParts=[Buffer.from('%PDF-1.4\n')],plainOffsets:number[]=[];let plainLength=plainParts[0].length;
  plainObjects.forEach((object,index)=>{plainOffsets.push(plainLength);const part=Buffer.from(`${index+1} 0 obj\n${object}\nendobj\n`);plainParts.push(part);plainLength+=part.length;});
  plainParts.push(Buffer.from(`xref\n0 ${plainObjects.length+1}\n0000000000 65535 f \n${plainOffsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${plainObjects.length+1} /Root 1 0 R >>\nstartxref\n${plainLength}\n%%EOF\n`));writeFileSync(plainPath,Buffer.concat(plainParts));
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));

test('可直接提取文字的 PDF 不产生识图页面或模型请求',async()=>{
  let calls=0;
  const document=await parsePdfDocument(plainPath,{ocrPage:async()=>{calls++;return {status:'success',text:'unexpected',model:'fixture'};}});
  expect(renderStructuredDocument(document)).toContain('Native searchable PDF text');
  expect(document.metadata.pagesNeedingOcr??[]).toEqual([]);
  expect(calls).toBe(0);
});

test('关闭结构化解析时，可读 PDF 直接提取文字，扫描页仍可以识图',async()=>{
  const calls:number[]=[];
  const document=await parsePdfDocument(path,{structured:false,ocrPage:async(page)=>{
    calls.push(page);
    return {status:'success',text:`非结构化扫描页${page}`,model:'fixture'};
  }});
  expect(calls).toEqual([1,2]);
  expect(renderStructuredDocument(document)).toContain('Native header');
  expect(document.sections.some(section=>section.locator?.page===1&&section.text?.includes('非结构化扫描页1'))).toBe(true);
});

test('需要识图的两页可同时处理，结果仍对应原始页码',async()=>{
  let active=0,peak=0,release!:()=>void;
  const secondStarted=new Promise<void>(resolve=>{release=resolve;});
  const runtime=new DocumentRuntime({sample:()=>({bytes:0,availableBytes:12*1024**3,totalBytes:16*1024**3,cpuBusyRatio:0.1})});
  const document=await retryPdfOcrPages(path,[1,2],{runtime,ocrPage:async(page)=>{
    active++;peak=Math.max(peak,active);
    if(page===1)await Promise.race([secondStarted,Bun.sleep(700)]);else release();
    active--;
    return {status:'success',text:`并发页面${page}`,model:'fixture'};
  }});
  expect(peak).toBe(2);
  expect(document.metadata.ocrSucceeded).toBe(2);
  expect(document.sections.find(section=>section.locator?.page===1)?.text).toContain('并发页面1');
  expect(document.sections.find(section=>section.locator?.page===2)?.text).toContain('并发页面2');
});

test('scanned and mixed pages read images with original page numbers, without rescanning searchable images or tiny logos',async()=>{
  const calls:number[]=[];const document=await parsePdfDocument(path,{ocrPage:async(page)=>{calls.push(page);return {status:'success',text:`image-only-evidence-page-${page}`,model:'fixture'};}});
  expect(calls).toEqual([1,2]);expect(document.metadata.pagesNeedingOcr).toEqual([1,2]);
  expect(document.metadata.ocrAttempted).toBe(2);expect(document.metadata.ocrSucceeded).toBe(2);
  expect(document.sections.find(section=>section.text?.includes('image-only-evidence-page-2'))?.locator?.page).toBe(2);
  const text=renderStructuredDocument(document);expect(text).toContain('Native header');expect(text).toContain('Searchable image text already present');
});
test('mixed image recognition failures keep native text and a failed receipt without substituting another result',async()=>{
  const document=await parsePdfDocument(path,{ocrPage:async(page)=>page===1?{status:'success',text:'scanned evidence',model:'fixture'}:{status:'failed',text:'',model:'fixture',message:'native provider rejected image'}});
  expect(renderStructuredDocument(document)).toContain('Native header');expect(document.metadata.ocrFailed).toBe(1);expect(document.metadata.ocrSucceeded).toBe(1);expect(document.metadata.ocrWarnings?.join(' ')).toContain('第 2 页');expect(document.metadata.ocrWarnings?.join(' ')).toContain('native provider rejected image');
});
test('without OCR callback the native parser makes no image recognition attempt',async()=>{
  const document=await parsePdfDocument(path);expect(document.metadata.ocrUsed).toBe(false);expect(document.metadata.ocrAttempted).toBeUndefined();expect(renderStructuredDocument(document)).toContain('Native header');
});
test('后台识图先提取 PDF 原文并定位待识别页，不调用识图或重复已含文字的图片',async()=>{
  let calls=0;const document=await parsePdfDocument(path,{deferOcr:true,structured:false,ocrPage:async()=>{calls++;return {status:'success',text:'unexpected',model:'fixture'};}});
  expect(calls).toBe(0);expect(document.metadata.pagesNeedingOcr).toEqual([1,2]);expect(document.metadata.ocrSkipped).toBe(2);expect(document.metadata.ocrWarnings).toEqual(['第 1 页：后台识图待完成','第 2 页：后台识图待完成']);expect(renderStructuredDocument(document)).toContain('Native header');expect(renderStructuredDocument(document)).toContain('Searchable image text already present');
});
test('分页提取保留末页文字，并按实际原始页码返回定位',async()=>{
  const document=await parsePdfDocument(path);
  expect(renderStructuredDocument(document)).toContain('Native document with a small logo');expect(document.sections.some(section=>section.locator?.page===4&&(section.text??section.heading)?.includes('Native document'))).toBe(true);
});
test('分页批次切换后末页的混合图片仍识别，页码与原文一致',async()=>{
  const tailPath=join(root,'tail-image.pdf'),bytes=readFileSync(path);const marker=bytes.indexOf('20 0 0 20 40 600');expect(marker).toBeGreaterThan(0);bytes.write('99 0 0 99 40 600',marker,'ascii');writeFileSync(tailPath,bytes);
  const pages:number[]=[];const document=await parsePdfDocument(tailPath,{runtime:new DocumentRuntime({sample:()=>({bytes:1024**3,availableBytes:3*1024**3,totalBytes:8*1024**3,cpuBusyRatio:0.95})}),ocrPage:async page=>{pages.push(page);return {status:'success',text:`image-evidence-${page}`,model:'fixture'};}});
  expect(pages).toEqual([1,2,4]);expect(document.sections.some(section=>section.locator?.page===4&&section.text?.includes('image-evidence-4'))).toBe(true);
});
test('OCR 回调的中断和存储错误保留原错误，不伪装成解析降级成功',async()=>{
  await expect(parsePdfDocument(path,{ocrPage:async()=>{throw new Error('OCR storage interrupted');}})).rejects.toThrow('OCR storage interrupted');
});

test('失败页单独补齐，只渲染识别所选页面，非法旧页码明确失败',async()=>{
  const calls:number[]=[];const document=await retryPdfOcrPages(path,[2],{ocrPage:async page=>{calls.push(page);return {status:'success',text:'only-failed-page-two',model:'fixture'};}});
  expect(calls).toEqual([2]);expect(document.metadata.ocrSucceeded).toBe(1);expect(document.sections.every(section=>section.locator?.page===2)).toBe(true);
  await expect(retryPdfOcrPages(path,[999],{})).rejects.toThrow('页码不存在');
});

test('PDF识图文字达到当前内存额度后停止，不再识别后续页面',async()=>{
  let calls=0;const runtime=new DocumentRuntime({sample:()=>({bytes:0,availableBytes:512*1024**2,totalBytes:32*1024**3})});
  await expect(parsePdfDocument(path,{runtime,ocrPage:async()=>{calls++;return {status:'success',text:'X'.repeat(9*1024**2),model:'fixture'};}})).rejects.toThrow('解析正文超过本机处理额度');
  expect(calls).toBe(1);
});
