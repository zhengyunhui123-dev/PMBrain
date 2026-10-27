import {open,type FileHandle} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInflateRaw} from 'node:zlib';
import {DocumentRuntime} from './resource-policy.ts';

interface Entry {offset:number;compressed:number;expanded:number;method:number;crc:number}
const crcTable=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;});
export class DocumentZip {
  private entries=new Map<string,Entry>();
  private constructor(private path:string,private handle:FileHandle,readonly runtime:DocumentRuntime){}
  static async open(path:string,runtime=new DocumentRuntime()){
    await runtime.checkpoint(true);const file=await open(path,'r');
    try{
      const size=(await file.stat()).size;
      if(size>runtime.plan.maxFileBytes)throw new Error(`资源保护：Office 文件超过本机处理额度 ${runtime.plan.maxFileBytes} bytes`);
      const tail=Buffer.alloc(Math.min(size,65557));await file.read(tail,0,tail.length,size-tail.length);
      let end=tail.length-22;while(end>=0&&(tail.readUInt32LE(end)!==0x06054b50||end+22+tail.readUInt16LE(end+20)!==tail.length))end--;
      if(end<0)throw new Error('Office ZIP 缺少有效目录');
      const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
      if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||count===65535||length===0xffffffff||offset===0xffffffff)throw new Error('Office ZIP64 或分卷格式尚不支持');
      if(length>8*1024**2||offset+length>size-tail.length+end)throw new Error('资源保护：Office ZIP 目录过大或无效');
      const directory=Buffer.alloc(length);await file.read(directory,0,length,offset);
      const zip=new DocumentZip(path,file,runtime);let cursor=0,expanded=0;
      for(let i=0;i<count;i++){
        if(cursor+46>length||directory.readUInt32LE(cursor)!==0x02014b50)throw new Error('Office ZIP 目录损坏');
        const nameLength=directory.readUInt16LE(cursor+28),extra=directory.readUInt16LE(cursor+30),comment=directory.readUInt16LE(cursor+32);
        const name=directory.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
        const entry={method:directory.readUInt16LE(cursor+10),crc:directory.readUInt32LE(cursor+16),compressed:directory.readUInt32LE(cursor+20),expanded:directory.readUInt32LE(cursor+24),offset:directory.readUInt32LE(cursor+42)};
        if(directory.readUInt16LE(cursor+8)&1)throw new Error('加密 Office 文件无法读取');
        if(![0,8].includes(entry.method)||entry.offset+entry.compressed>offset)throw new Error('Office ZIP 压缩方式或数据位置无效');
        expanded+=entry.expanded;
        if(expanded>runtime.plan.maxExpandedBytes)throw new Error(`资源保护：Office 解压内容超过本机处理额度 ${runtime.plan.maxExpandedBytes} bytes`);
        if(zip.entries.has(name))throw new Error(`Office ZIP 包含重复内容项：${name}`);
        zip.entries.set(name,entry);cursor+=46+nameLength+extra+comment;
        if(cursor>length)throw new Error('Office ZIP 目录长度无效');
      }
      return zip;
    }catch(error){await file.close();throw error;}
  }
  names(){return [...this.entries.keys()];}
  has(name:string){return this.entries.has(name);}
  file(name:string){return this.has(name)?{async:(kind:string)=>kind==='text'?this.text(name):this.buffer(name)}:null;}
  async close(){await this.handle.close();}
  async *stream(name:string):AsyncGenerator<Buffer>{
    const entry=this.entries.get(name);if(!entry)throw new Error(`Office ZIP 缺少 ${name}`);
    const header=Buffer.alloc(30);await this.handle.read(header,0,30,entry.offset);
    if(header.readUInt32LE(0)!==0x04034b50)throw new Error(`Office ZIP 内容项损坏：${name}`);
    const start=entry.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28);
    if(!entry.compressed){if(entry.expanded||entry.crc)throw new Error(`Office ZIP 内容项长度无效：${name}`);return;}
    const input=createReadStream(this.path,{start,end:start+entry.compressed-1,highWaterMark:64*1024,signal:this.runtime.signal});
    const output=entry.method===8?input.pipe(createInflateRaw({chunkSize:64*1024})):input;
    const forward=(error:Error)=>output.destroy(error);if(output!==input)input.on('error',forward);
    let size=0,crc=0xffffffff;
    try{
      for await(const piece of output){
        this.runtime.signal?.throwIfAborted();const buffer=piece as Buffer;size+=buffer.length;
        if(size>entry.expanded||size>this.runtime.plan.maxExpandedBytes)throw new Error(`资源保护：Office 解压长度异常：${name}`);
        for(const value of buffer)crc=crcTable[(crc^value)&255]^(crc>>>8);
        yield buffer;
      }
      if(size!==entry.expanded||((crc^0xffffffff)>>>0)!==entry.crc)throw new Error(`Office ZIP 校验失败：${name}`);
    }finally{input.destroy();if(output!==input)output.destroy();}
  }
  async buffer(name:string,limit=this.runtime.plan.maxRecordBytes){
    const buffers:Buffer[]=[];let bytes=0;
    for await(const buffer of this.stream(name)){bytes+=buffer.length;if(bytes>limit)throw new Error(`资源保护：Office 内容项过大：${name}`);buffers.push(buffer);}
    return Buffer.concat(buffers,bytes);
  }
  async text(name:string,limit?:number){return (await this.buffer(name,limit)).toString('utf8');}
}

export async function* xmlElements(zip:DocumentZip,name:string,tags:ReadonlySet<string>):AsyncGenerator<{xml:string;ancestors:Array<{name:string;id:number}>}>{
  const decoder=new TextDecoder();let buffer='',capture='',bytes=0,depth=0,sequence=0;
  const stack:Array<{name:string;id:number}>=[];let ancestors:typeof stack=[];
  for await(const piece of zip.stream(name)){
    buffer+=decoder.decode(piece,{stream:true});
    for(;;){
      const begin=buffer.indexOf('<');
      if(begin<0){if(depth){capture+=buffer;bytes+=Buffer.byteLength(buffer);}buffer='';break;}
      if(depth){capture+=buffer.slice(0,begin);bytes+=Buffer.byteLength(buffer.slice(0,begin));}
      buffer=buffer.slice(begin);
      const special=buffer.startsWith('<!--')?'-->':buffer.startsWith('<![CDATA[')?']]>':buffer.startsWith('<?')?'?>':null;
      let end=-1;
      if(special){const found=buffer.indexOf(special);if(found>=0)end=found+special.length-1;}
      else{let quote='';for(let i=1;i<buffer.length;i++){const c=buffer[i];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>'){end=i;break;}}}
      if(end<0){if(Buffer.byteLength(buffer)>zip.runtime.plan.maxRecordBytes)throw new Error('资源保护：Office XML 标记过长');break;}
      const token=buffer.slice(0,end+1);buffer=buffer.slice(end+1);
      if(!special&&/^<!/i.test(token))throw new Error('Office XML 不允许 DTD 声明');
      const match=special?null:token.match(/^<(\/)?([^\s/>]+)/),closing=!!match?.[1],self=token.endsWith('/>');
      if(!depth&&match&&!closing&&tags.has(match[2])){capture='';bytes=0;depth=1;ancestors=[...stack];}
      else if(depth&&match){if(closing)depth--;else if(!self)depth++;}
      if(depth||capture){capture+=token;bytes+=Buffer.byteLength(token);}
      if(match){
        if(closing){if(stack.at(-1)?.name!==match[2])throw new Error('Office XML 标签不匹配');stack.pop();}
        else if(!self){stack.push({name:match[2],id:++sequence});if(stack.length>128)throw new Error('资源保护：Office XML 嵌套过深');}
      }
      if(bytes>zip.runtime.plan.maxRecordBytes)throw new Error('资源保护：Office 单段内容过大');
      if(capture&&(depth===0||(self&&depth===1&&tags.has(match?.[2]??'')))){const xml=capture;capture='';bytes=0;depth=0;yield {xml,ancestors};await zip.runtime.checkpoint();}
    }
    if(bytes>zip.runtime.plan.maxRecordBytes)throw new Error('资源保护：Office 单段内容过大');
  }
  buffer+=decoder.decode();if(depth||stack.length||buffer.trim())throw new Error('Office XML 内容不完整');
}
