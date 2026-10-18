import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFParse} from 'pdf-parse';
import {pdfRuntimeOptions} from '../src/core/document/pdf-runtime';

let root:string;let path:string;
beforeAll(()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-pdf-cmap-'));path=join(root,'cjk.pdf');
  const content='BT /F1 20 Tf 40 700 Td <B2E2CAD4> Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,'<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [6 0 R] >>','<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>','<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 8 >>\nstartxref\n${xref}\n%%EOF\n`;writeFileSync(path,pdf);
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));

test('Chinese predefined CMap resolves actual text using local packaged resources',async()=>{
  const parser=new PDFParse({data:new Uint8Array(await Bun.file(path).arrayBuffer()),...pdfRuntimeOptions()});
  try{expect((await parser.getText()).text).toContain('测试');}finally{await parser.destroy();}
});
test('CMaps, standard fonts and WASM paths resolve to installed local resources',()=>{
  const options=pdfRuntimeOptions();expect(options.cMapPacked).toBe(true);
  expect(existsSync(join(options.cMapUrl,'GBK-EUC-H.bcmap'))).toBe(true);
  expect(existsSync(join(options.standardFontDataUrl,'LiberationSans-Regular.ttf'))).toBe(true);
  expect(existsSync(join(options.wasmUrl,'openjpeg.wasm'))).toBe(true);
});
