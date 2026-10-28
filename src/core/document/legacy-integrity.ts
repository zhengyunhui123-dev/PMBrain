import {markdownToSections} from './parsers/markdown-sections.ts';
import {sectionPlainText} from './normalize.ts';
import {stripTakesFence} from '../takes-fence.ts';
import {stripFactsFence} from '../facts-fence.ts';
import type {DocumentRuntime} from './resource-policy.ts';

export interface LegacyChunk {chunk_index:number;chunk_text:string;chunk_source:string}
function visibleSections(text:string){
  return markdownToSections(stripFactsFence(stripTakesFence(text),{keepVisibility:['world']})).map(section=>({text:sectionPlainText(section),heading:section.type==='heading'})).filter(section=>section.text.trim());
}
export function legacyVisibleText(text:string){
  return visibleSections(text).map(section=>section.text).join('').replace(/([A-Za-z0-9])\s+(?=[A-Za-z0-9])/g,'$1\u0001').replace(/\s+/g,'').replace(/\u0001/g,' ').replace(/\|+/g,'|').replace(/^\||\|$/g,'');
}
function chunkBody(chunk:LegacyChunk,title:string){
  if(chunk.chunk_source!=='office_child')return chunk.chunk_source==='compiled_truth'?chunk.chunk_text:null;
  if(!chunk.chunk_text.startsWith('Parent document: '))return chunk.chunk_text;
  const split=chunk.chunk_text.indexOf('\n\n'),header=chunk.chunk_text.slice(0,split);
  return split>=0&&header.startsWith(`Parent document: ${title}\nSection: `)&&header.includes('\nLocator: ')?chunk.chunk_text.slice(split+2):null;
}
export async function inspectLegacyChunks(body:string,title:string,chunks:LegacyChunk[],runtime?:DocumentRuntime){
  const sections=visibleSections(body).filter(section=>!(section.heading&&section.text===title));
  const segments=sections.map(section=>({...section,canonical:legacyVisibleText(section.text)}));
  const whole=segments.map(section=>section.canonical).join(''),covered=new Uint8Array(whole.length);
  for(let index=0;index<whole.length;index++)if(whole[index]==='|'||whole[index]===' ')covered[index]=1;
  const invalid:number[]=[],seen=new Set<string>(),titleText=legacyVisibleText(title);
  for(const chunk of chunks){
    await runtime?.checkpoint();const payload=chunkBody(chunk,title),texts:string[]=[];
    let valid=payload!==null;
    for(const line of payload?.split(/\n+/)??[]){
      if(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))continue;
      const text=legacyVisibleText(line);if(!text||text===titleText)continue;
      if(!seen.has(text)&&!whole.includes(text)){valid=false;break;}
      texts.push(text);
    }
    if(!valid){invalid.push(chunk.chunk_index);continue;}
    for(const text of texts){
      if(seen.has(text))continue;seen.add(text);let start=whole.indexOf(text),matches=0;
      while(start>=0){covered.fill(1,start,start+text.length);start=whole.indexOf(text,start+1);if(++matches%1000===0)await runtime?.checkpoint();}
    }
  }
  const missing:string[]=[];let offset=0;
  for(const section of segments){
    const end=offset+section.canonical.length;
    if(section.canonical&&covered.subarray(offset,end).some(value=>value===0))missing.push(section.text);
    offset=end;
  }
  const coveredText=(text:string)=>{
    const canonical=legacyVisibleText(text);if(!canonical)return true;
    let start=whole.indexOf(canonical);
    while(start>=0){if(covered.subarray(start,start+canonical.length).every(value=>value===1))return true;start=whole.indexOf(canonical,start+1);}
    return false;
  };
  return {invalid,missing,coveredText};
}
