import {createHash} from 'node:crypto';
import type {BrainEngine} from '../engine.ts';
import {OCR_PROMPT_VERSION,type OcrImageResult} from '../ocr.ts';
import type {OcrPageHandler,OcrPageInput} from './types.ts';
import {settleOcrRequests} from './ocr-concurrency.ts';

export function createDocumentOcr(engine:BrainEngine,sourceId:string,recognize:(image:Buffer,mime:string)=>Promise<OcrImageResult>,enabled=true,
  recognizeBatch?:(items:Array<{id:string;bytes:Buffer;mime:string}>)=>Promise<OcrImageResult[]>):OcrPageHandler{
  const keyFor=(item:OcrPageInput)=>`document.ocr.v1.${createHash('sha256').update(JSON.stringify([sourceId,OCR_PROMPT_VERSION,item.mime])).update(item.image).digest('hex')}`;
  const batch=async(items:OcrPageInput[]):Promise<OcrImageResult[]>=>{
    const groups=new Map<string,{item:OcrPageInput;indexes:number[]}>();
    items.forEach((item,index)=>{const key=keyFor(item),group=groups.get(key);if(group)group.indexes.push(index);else groups.set(key,{item,indexes:[index]});});
    const results:OcrImageResult[]=new Array(items.length),pending:Array<{key:string;item:OcrPageInput;indexes:number[]}>=[];
    for(const [key,group] of groups){
      const stored=await engine.getConfig(key);
      const cached=stored?JSON.parse(stored) as OcrImageResult:null;
      if(cached?.status==='success'&&(cached.text.trim()||cached.code==='no_text')){
        for(const index of group.indexes)results[index]={...cached,reused:true};
      }else if(!enabled){
        for(const index of group.indexes)results[index]={status:'skipped',text:'',model:null,code:'disabled',message:'本次未启用图片识别'};
      }else pending.push({key,...group});
    }
    if(pending.length){
      const recognized=pending.length>1&&recognizeBatch
        ?await recognizeBatch(pending.map((entry,index)=>({id:String(index+1),bytes:entry.item.image,mime:entry.item.mime})))
        :await settleOcrRequests(pending.map(entry=>recognize(entry.item.image,entry.item.mime)));
      if(recognized.length!==pending.length)throw new Error('批量识图结果数量不匹配');
      for(let index=0;index<pending.length;index++){
        const entry=pending[index],result={...recognized[index],recognizedAt:new Date().toISOString()};
        if(result.status==='success'&&(result.text.trim()||result.code==='no_text'))await engine.setConfig(entry.key,JSON.stringify(result));
        for(const [position,target] of entry.indexes.entries())results[target]=position&&result.status==='success'?{...result,reused:true}:result;
      }
    }
    return results;
  };
  const handler:OcrPageHandler=async(page,image,mime)=>(await batch([{page,image,mime}]))[0];
  handler.batch=batch;
  return handler;
}
