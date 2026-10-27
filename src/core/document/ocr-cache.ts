import {createHash} from 'node:crypto';
import type {BrainEngine} from '../engine.ts';
import {OCR_PROMPT_VERSION,type OcrImageResult} from '../ocr.ts';

export function createDocumentOcr(engine:BrainEngine,sourceId:string,recognize:(image:Buffer,mime:string)=>Promise<OcrImageResult>,enabled=true){
  return async (_page:number,image:Buffer,mime:string):Promise<OcrImageResult>=>{
    const hash=createHash('sha256').update(JSON.stringify([sourceId,OCR_PROMPT_VERSION,mime])).update(image).digest('hex');
    const key=`document.ocr.v1.${hash}`;
    const stored=await engine.getConfig(key);
    if(stored){
      const cached=JSON.parse(stored) as OcrImageResult;
      if(cached.status==='success'&&(cached.text.trim()||cached.code==='no_text'))return {...cached,reused:true};
    }
    if(!enabled)return {status:'skipped',text:'',model:null,code:'disabled',message:'本次未启用图片识别'};
    const result={...await recognize(image,mime),recognizedAt:new Date().toISOString()};
    if(result.status==='success'&&(result.text.trim()||result.code==='no_text'))await engine.setConfig(key,JSON.stringify(result));
    return result;
  };
}
