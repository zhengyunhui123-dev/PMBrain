import {mkdtemp,open,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,extname,join,posix,resolve,sep} from 'node:path';
import * as XLSX from 'xlsx';
import {XMLParser} from 'fast-xml-parser';
import {DocumentZip,xmlElements} from '../zip-reader.ts';
import {DocumentRuntime} from '../resource-policy.ts';
import {asArray,objectXmlParser,orderedXmlParser,orderedText} from './ooxml.ts';
import {cleanCell} from '../normalize.ts';
import type {DocumentSection,StructuredDocument} from '../types.ts';

const cellsParser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',trimValues:false,parseTagValue:false,removeNSPrefix:true});

export async function parseDelimitedStream(path:string,runtime=new DocumentRuntime()):Promise<StructuredDocument>{
  await runtime.checkpoint(true);const sections:DocumentSection[]=[];let row:string[]=[],cell='',quoted=false,pendingQuote=false,cr=false,number=0,start=0,rows:string[][]=[],characters=0,bytes=0,first=true;
  const separator=extname(path).toLowerCase()==='.tsv'?'\t':',';
  const flush=()=>{if(!rows.length)return;const width=Math.max(...rows.map(row=>row.length),1),table=sections.length+1;sections.push({id:`csv-${table}`,type:'table',table:{headers:rows[0],rows:rows.slice(1)},locator:{sheet:'Sheet1',table,range:`A${start}:${XLSX.utils.encode_col(width-1)}${number}`,headingPath:['Sheet1']}});rows=[];characters=0;};
  const finishRow=async()=>{
    row.push(cleanCell(cell));cell='';number++;const size=row.join(' | ').length;bytes+=Buffer.byteLength(row.join(' | '));runtime.assertText(bytes);
    if(!row.some(Boolean))flush();else{if(rows.length>1&&(rows.length>=200||characters+size>30000))flush();if(!rows.length)start=number;rows.push(row);characters+=size;}row=[];await runtime.checkpoint();
  };
  const outside=(c:string)=>{
    if(cr){cr=false;if(c==='\n')return false;}
    if(c===separator){row.push(cleanCell(cell));cell='';if(row.length>16384)throw new Error('资源保护：CSV 列数超过处理额度');}
    else if(c==='\r'||c==='\n'){cr=c==='\r';return true;}
    else if(c==='"'&&!cell.length)quoted=true;
    else cell+=c;
    return false;
  };
  for await(const piece of createReadStream(path,{encoding:'utf8',highWaterMark:64*1024,signal:runtime.signal})){
    for(const c of piece as string){
      if(first){first=false;if(c==='\uFEFF')continue;}
      let endRow=false;
      if(quoted){if(c==='"'){if(pendingQuote){cell+='"';pendingQuote=false;}else pendingQuote=true;}else if(pendingQuote){quoted=false;pendingQuote=false;endRow=outside(c);}else cell+=c;}
      else endRow=outside(c);
      if(endRow)await finishRow();
      if(cell.length>runtime.plan.maxRecordBytes/4)throw new Error('资源保护：CSV 单元格超过处理额度');
    }
    await runtime.checkpoint(true);
  }
  if(quoted&&!pendingQuote)throw new Error('CSV 引号未闭合');if(cell.length||row.length)await finishRow();flush();
  return {title:basename(path,extname(path)),format:'xlsx',sections,metadata:{parser:'pmbrain-delimited-v3',structured:true,local:true,sheetCount:1,tableCount:sections.length,imageCount:0,ocrUsed:false}};
}

export async function parseSpreadsheetStream(path:string,runtime=new DocumentRuntime()):Promise<StructuredDocument>{
  const zip=await DocumentZip.open(path,runtime),directory=await mkdtemp(join(tmpdir(),'pmbrain-sheet-strings-'));
  let strings:Awaited<ReturnType<typeof open>>|undefined,index:typeof strings;
  try{
    const book=objectXmlParser.parse(await zip.text('xl/workbook.xml')) as any;
    const relationships=zip.has('xl/_rels/workbook.xml.rels')?objectXmlParser.parse(await zip.text('xl/_rels/workbook.xml.rels')) as any:{};
    const targets=new Map<string,string>(asArray(relationships.Relationships?.Relationship).map((rel:any)=>[String(rel.Id),String(rel.Target)]));
    const sheets=asArray(book.workbook?.sheets?.sheet) as any[];
    if(!sheets.length)throw new Error('Excel 文件中没有工作表');
    const formats=new Map<number,string>();let styles:number[]=[];
    if(zip.has('xl/styles.xml')){
      const style=objectXmlParser.parse(await zip.text('xl/styles.xml')) as any;
      for(const format of asArray(style.styleSheet?.numFmts?.numFmt) as any[])formats.set(Number(format.numFmtId),String(format.formatCode));
      styles=(asArray(style.styleSheet?.cellXfs?.xf) as any[]).map(style=>Number(style.numFmtId??0));
    }
    const date1904=String(book.workbook?.workbookPr?.date1904??'false');
    let stringCount=0,stringBytes=0;
    if(zip.has('xl/sharedStrings.xml')){
      strings=await open(join(directory,'values'),'wx+',0o600);index=await open(join(directory,'index'),'wx+',0o600);
      for await(const item of xmlElements(zip,'xl/sharedStrings.xml',new Set(['si']))){
        const text=orderedText(orderedXmlParser.parse(item.xml)),bytes=Buffer.from(text),record=Buffer.alloc(12);
        record.writeBigUInt64LE(BigInt(stringBytes));record.writeUInt32LE(bytes.length,8);
        await strings.writeFile(bytes);await index.writeFile(record);stringBytes+=bytes.length;stringCount++;
      }
    }
    const cached=new Map<number,string>();
    const shared=async(id:number)=>{
      if(cached.has(id))return cached.get(id)!;
      if(!strings||!index||!Number.isInteger(id)||id<0||id>=stringCount)throw new Error('Excel 共享字符串引用无效');
      const record=Buffer.alloc(12);await index.read(record,0,12,id*12);const bytes=Buffer.alloc(record.readUInt32LE(8));
      await strings.read(bytes,0,bytes.length,Number(record.readBigUInt64LE(0)));const text=bytes.toString('utf8');
      if(cached.size>=128)cached.delete(cached.keys().next().value!);cached.set(id,text);return text;
    };
    const sections:DocumentSection[]=[];let tables=0,totalBytes=0;
    for(const [sheetIndex,sheet] of sheets.entries()){
      await runtime.checkpoint(true);
      const raw=targets.get(String(sheet['r:id']??sheet.id))??`worksheets/sheet${sheetIndex+1}.xml`;
      const name=raw.startsWith('/')?raw.slice(1):posix.normalize(posix.join('xl',raw));
      if(!name.startsWith('xl/')||!zip.has(name))throw new Error(`Excel 工作表位置无效：${raw}`);
      const merges:Array<{s:{r:number;c:number};e:{r:number;c:number};value?:string}>=[];
      for await(const item of xmlElements(zip,name,new Set(['mergeCell']))){
        const value=cellsParser.parse(item.xml).mergeCell,range=XLSX.utils.decode_range(String(value.ref));
        if(range.e.r-range.s.r>100000||range.e.c>16383||merges.length>=100000)throw new Error('资源保护：Excel 合并区域超过处理额度');merges.push(range);
      }
      merges.sort((a,b)=>a.s.r-b.s.r);let mergeIndex=0,active:typeof merges=[];
      let rows:string[][]=[],start=0,last=0,width=0,characters=0;
      const flush=()=>{
        if(!rows.length)return;tables++;
        const range=`A${start+1}:${XLSX.utils.encode_col(width-1)}${last+1}`;
        const normalized=rows.map(row=>Array.from({length:width},(_,i)=>row[i]??''));
        sections.push({id:`xlsx-${tables}`,type:'table',heading:`Sheet：${sheet.name} · Table ${tables}`,table:{headers:normalized[0],rows:normalized.slice(1)},locator:{sheet:String(sheet.name),table:tables,range,headingPath:[String(sheet.name)]}});
        rows=[];width=0;characters=0;
      };
      const push=(row:string[],number:number)=>{
        while(mergeIndex<merges.length&&merges[mergeIndex].s.r<=number)active.push(merges[mergeIndex++]);
        active=active.filter(merge=>merge.e.r>=number);
        for(const merge of active){if(number===merge.s.r)merge.value=row[merge.s.c];if(merge.value)for(let c=merge.s.c;c<=merge.e.c;c++)row[c]=merge.value;}
        if(!row.some(Boolean)){flush();last=number;return;}
        const size=row.join('|').length;totalBytes+=Buffer.byteLength(row.join(' | '));runtime.assertText(totalBytes);
        if(rows.length>1&&(rows.length>=200||characters+size>30000))flush();
        if(!rows.length)start=number;rows.push(row);last=number;width=Math.max(width,row.length);characters+=size;
      };
      let previous=-1;
      for await(const item of xmlElements(zip,name,new Set(['row']))){
        const row=cellsParser.parse(item.xml).row,number=Number(row.r??previous+2)-1;
        if(!Number.isInteger(number)||number<=previous||number>=1048576)throw new Error('Excel 行号无效');
        if(number>previous+1){if(active.some(merge=>merge.value&&merge.e.r>previous)){for(let r=previous+1;r<number;r++){push([],r);await runtime.checkpoint();}}else flush();}
        const values:string[]=[];
        const inline=new Map<string,string>();
        if(asArray(row.c).some((cell:any)=>cell.t==='inlineStr'))for(const node of orderedXmlParser.parse(item.xml)[0]?.row??[]){if(node.c)inline.set(String(node[':@']?.r??''),orderedText(node.c));}
        for(const cell of asArray(row.c) as any[]){
          const column=cell.r?XLSX.utils.decode_cell(String(cell.r)).c:values.length;if(column>16383)throw new Error('Excel 列号超出范围');
          let value=cell.v??'';
          if(cell.t==='s')value=await shared(Number(value));
          else if(cell.t==='inlineStr')value=inline.get(String(cell.r??''))??'';
          else if(cell.t==='b')value=String(value)==='1'?'TRUE':'FALSE';
          else if(!cell.t||cell.t==='n'){
            const numeric=Number(value);if(value!==''&&Number.isFinite(numeric))value=XLSX.SSF.format(formats.get(styles[Number(cell.s??0)])??styles[Number(cell.s??0)]??0,numeric,{date1904:date1904==='true'||date1904==='1'});
          }
          values[column]=cleanCell(value);
        }
        push(values,number);previous=number;
        if((number+1)%runtime.plan.rows===0)process.stderr.write(`${JSON.stringify({event:'tick',phase:'import.process',done:number+1,unit:'行',stage:`读取工作表 ${sheet.name}，已解析 ${number+1} 行`})}\n`);
      }
      if(active.some(merge=>merge.value&&merge.e.r>previous)){const end=Math.max(...active.map(merge=>merge.e.r));for(let r=previous+1;r<=end;r++){push([],r);await runtime.checkpoint();}}
      flush();
    }
    return {title:basename(path,extname(path)),format:'xlsx',sections,metadata:{parser:'pmbrain-spreadsheet-v3',structured:true,local:true,sheetCount:sheets.length,tableCount:tables,imageCount:0,ocrUsed:false}};
  }finally{
    await strings?.close();await index?.close();await zip.close();
    if(!resolve(directory).startsWith(resolve(tmpdir())+sep)||!basename(directory).startsWith('pmbrain-sheet-strings-'))throw new Error('临时字符串目录校验失败');
    await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  }
}
