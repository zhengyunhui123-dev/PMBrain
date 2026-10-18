import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCanvas} from '@napi-rs/canvas';
import {parsePdfDocument} from '../src/core/document/parsers/pdf';
import {renderStructuredDocument} from '../src/core/document/markdown-renderer';

let root:string;let path:string;
beforeAll(()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-pdf-ocr-'));path=join(root,'mixed.pdf');
  const canvas=createCanvas(512,512);const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,512,512);ctx.fillStyle='black';ctx.fillText('image evidence',25,25);
  const image=canvas.toBuffer('image/jpeg');
  const streams=['q 500 0 0 500 40 120 cm /Im1 Do Q','BT /F1 12 Tf 40 760 Td (Native header) Tj ET q 500 0 0 500 40 120 cm /Im1 Do Q','BT /F1 12 Tf 60 400 Td (Searchable image text already present) Tj ET q 500 0 0 500 40 120 cm /Im1 Do Q','BT /F1 12 Tf 40 760 Td (Native document with a small logo) Tj ET q 20 0 0 20 40 600 cm /Im1 Do Q'];
  const objects:Buffer[]=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>')];
  for(let i=0;i<4;i++){objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 11 0 R >> /XObject << /Im1 12 0 R >> >> /Contents ${4+i*2} 0 R >>`));objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(streams[i])} >>\nstream\n${streams[i]}\nendstream`));}
  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 512 /Height 512 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]));
  const parts=[Buffer.from('%PDF-1.4\n')];const offsets=[0];let length=parts[0].length;
  objects.forEach((object,i)=>{offsets.push(length);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),object,Buffer.from('\nendobj\n')]);parts.push(part);length+=part.length;});
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));writeFileSync(path,Buffer.concat(parts));
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));

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
