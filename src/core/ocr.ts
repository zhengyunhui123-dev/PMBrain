import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';

export const OCR_RECEIPT_VERSION = 1;
export const OCR_PROMPT_VERSION = 4;

function ocrRequestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>();
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 5 && !seen.has(current); depth++) {
    seen.add(current);
    const entry = current as { responseBody?: unknown; cause?: unknown; lastError?: unknown };
    if (typeof entry.responseBody === 'string') {
      try {
        const body = JSON.parse(entry.responseBody);
        const detail = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : undefined);
        if (typeof detail === 'string' && detail.trim() && !message.includes(detail)) return `${message}：${detail.slice(0, 1000)}`;
      } catch {}
    }
    current = entry.cause ?? entry.lastError;
  }
  return message;
}

export type OcrSkipCode =
  | 'disabled'
  | 'model_unconfigured'
  | 'model_unavailable'
  | 'model_no_vision'
  | 'no_text';

export interface OcrImageResult {
  reused?: boolean;
  recognizedAt?: string;
  status: 'success' | 'failed' | 'skipped';
  text: string;
  model: string | null;
  code?: OcrSkipCode | 'request_failed';
  message?: string;
}

export interface OcrReceipt {
  version: number;
  promptVersion: number;
  sourceHash: string;
  model: string | null;
  candidates: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failedItems: Array<string | number>;
  status: 'complete' | 'partial' | 'skipped';
  reason?: string;
  processedAt: string;
}

export function hashOcrSource(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function shouldRefreshOcrReceipt(
  receipt: OcrReceipt | null | undefined,
  sourceHash: string,
  model: string | null,
): boolean {
  if (!receipt) return true;
  if (receipt.version !== OCR_RECEIPT_VERSION || receipt.promptVersion !== OCR_PROMPT_VERSION) return true;
  if (receipt.sourceHash !== sourceHash || receipt.model !== model) return true;
  return receipt.status !== 'complete' || receipt.failed > 0;
}

async function bump(engine: BrainEngine, key: string): Promise<void> {
  try {
    if(typeof engine.executeRaw==='function'){
      await engine.executeRaw(`INSERT INTO config(key,value) VALUES($1,'1') ON CONFLICT(key) DO UPDATE
        SET value=(CASE WHEN config.value ~ '^[0-9]+$' THEN config.value::numeric ELSE 0 END+1)::text`,[key]);
      return;
    }
    const current = Number.parseInt((await engine.getConfig(key)) ?? '0', 10);
    await engine.setConfig(key, String((Number.isFinite(current) ? current : 0) + 1));
  } catch {
  }
}

export async function recognizeImagesText(
  engine:BrainEngine,
  images:Array<{id:string;bytes:Buffer;mime:string}>,
  opts:{enabled?:boolean;signal?:AbortSignal}={},
):Promise<OcrImageResult[]>{
  if(!images.length)return [];
  if(images.length===1)return [await recognizeImageText(engine,images[0].bytes,images[0].mime,opts)];
  const gateway=await import('./ai/gateway.ts');
  if(!(opts.enabled??gateway.isOcrEnabled()))return images.map(()=>({status:'skipped',text:'',model:null,code:'disabled',message:'图片识别未启用'}));
  let model:string;
  try{model=gateway.getImageOcrModel();}catch{return images.map(()=>({status:'skipped',text:'',model:null,code:'model_unconfigured',message:'未配置普通模型或图片/OCR模型'}));}
  if(gateway.getVisionCapability(model)==='unsupported'){
    for(const _ of images)await bump(engine,'ocr_failed_no_vision');
    return images.map(()=>({status:'skipped',text:'',model,code:'model_no_vision',message:`模型 ${model} 不支持图片输入`}));
  }
  if(!gateway.isAvailable('chat',model)){
    for(const _ of images)await bump(engine,'ocr_failed_no_key');
    return images.map(()=>({status:'skipped',text:'',model,code:'model_unavailable',message:`模型 ${model} 当前不可用，请检查 API Key 或本地服务`}));
  }
  for(const _ of images)await bump(engine,'ocr_attempted');
  try{
    const texts=await (await import('./pmbrain-adapters/ocr-batch.ts')).generateOcrBatch(images,opts.signal);
    const results:OcrImageResult[]=[];
    for(const text of texts){
      await bump(engine,'ocr_succeeded');
      results.push(text?{status:'success',text,model}:{status:'success',text:'',model,code:'no_text',message:'图片中未识别到文字'});
    }
    return results;
  }catch(error){
    for(const _ of images)await bump(engine,'ocr_failed_other');
    const message=ocrRequestError(error);
    return images.map(()=>({status:'failed',text:'',model,code:'request_failed',message}));
  }
}

export async function recognizeImageText(
  engine: BrainEngine,
  image: Buffer,
  mime: string,
  opts: { enabled?: boolean } = {},
): Promise<OcrImageResult> {
  const gateway = await import('./ai/gateway.ts');
  if (!(opts.enabled ?? gateway.isOcrEnabled())) {
    return { status: 'skipped', text: '', model: null, code: 'disabled', message: '图片识别未启用' };
  }

  let model: string;
  try {
    model = gateway.getImageOcrModel();
  } catch {
    return { status: 'skipped', text: '', model: null, code: 'model_unconfigured', message: '未配置普通模型或图片/OCR模型' };
  }
  const capability = gateway.getVisionCapability(model);
  if (capability === 'unsupported') {
    await bump(engine, 'ocr_failed_no_vision');
    return { status: 'skipped', text: '', model, code: 'model_no_vision', message: `模型 ${model} 不支持图片输入` };
  }
  if (!gateway.isAvailable('chat', model)) {
    await bump(engine, 'ocr_failed_no_key');
    return { status: 'skipped', text: '', model, code: 'model_unavailable', message: `模型 ${model} 当前不可用，请检查 API Key 或本地服务` };
  }

  await bump(engine, 'ocr_attempted');
  try {
    const text = await gateway.generateOcrText(image, mime);
    if (!text) {
      await bump(engine, 'ocr_succeeded');
      return { status: 'success', text: '', model, code: 'no_text', message: '图片中未识别到文字' };
    }
    await bump(engine, 'ocr_succeeded');
    return { status: 'success', text, model };
  } catch (error) {
    await bump(engine, 'ocr_failed_other');
    return {
      status: 'failed',
      text: '',
      model,
      code: 'request_failed',
      message: ocrRequestError(error),
    };
  }
}
