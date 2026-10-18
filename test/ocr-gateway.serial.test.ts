import {afterEach,expect,test} from 'bun:test';
import {createCanvas} from '@napi-rs/canvas';
import {configureGateway,resetGateway,__setChatTransportForTests,generateOcrText,type ChatResult,type ChatOpts} from '../src/core/ai/gateway';
import {recognizeImageText} from '../src/core/ocr';
import {ocrImageInputs} from '../src/core/ocr-images';

let server:ReturnType<typeof Bun.serve>|undefined;
afterEach(()=>{resetGateway();server?.stop(true);});
const usage={input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0};
const reply=(text:string,stopReason:ChatResult['stopReason']='end'):ChatResult=>({text,blocks:[{type:'text',text}],model:'mimo:mimo-v2.6-flash',providerId:'mimo',stopReason,usage});
function setup(){
  server=Bun.serve({port:0,fetch:()=>Response.json({id:'ocr-test',object:'chat.completion',created:1,model:'mimo-v2.6-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'旧式提取'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})});
  configureGateway({chat_model:'mimo:mimo-v2.6-flash',generative_enabled:true,base_urls:{mimo:server.url.origin+'/v1'},env:{MIMO_API_KEY:'isolated-test-only'}});
}
const counters=new Map<string,string>();
const engine={getConfig:async(key:string)=>counters.get(key)??null,setConfig:async(key:string,value:string)=>{counters.set(key,value);}} as any;

test('普通图片沿用一个原始输入，经已有 Gateway 保留模型、预算和逐字标签要求',async()=>{
  setup();let options:ChatOpts|undefined;
  __setChatTransportForTests(async opts=>{options=opts;return reply('标题\n  中间标题\n    叶节点');});
  const bytes=createCanvas(64,64).toBuffer('image/png');
  expect(await generateOcrText(bytes,'image/png')).toContain('中间标题');
  expect(options?.allowFallback).toBe(false);expect(options?.retryLength).toBe(true);expect(options?.maxTokens).toBeGreaterThanOrEqual(8192);
  expect(options?.system).toContain('intermediate');expect(options?.system).toContain('abbreviations');
  const parts=options!.messages[0]!.content as any[];
  const images=parts.filter(item=>item.type==='image');expect(images).toHaveLength(1);expect(images[0].image).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
});

test('超大 PNG 同一次请求携带总览及四块重叠细节，不修改原字节',async()=>{
  setup();let images:any[]=[];
  __setChatTransportForTests(async opts=>{images=(opts.messages[0]!.content as any[]).filter(item=>item.type==='image');return reply('全部层级原文');});
  const canvas=createCanvas(4200,4100);const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,4200,4100);context.fillStyle='black';context.fillText('层级标题',2100,2050);
  const bytes=canvas.toBuffer('image/png'),before=Buffer.from(bytes);
  expect(await generateOcrText(bytes,'image/png')).toBe('全部层级原文');expect(images).toHaveLength(5);expect(bytes.equals(before)).toBe(true);
});

test('输出持续截断时不把半篇内容记作识别成功，不切换模型',async()=>{
  setup();let calls=0;
  __setChatTransportForTests(async opts=>{calls++;expect(opts.model).toBe('mimo:mimo-v2.6-flash');return reply('半篇内容','length');});
  const result=await recognizeImageText(engine,createCanvas(64,64).toBuffer('image/png'),'image/png',{enabled:true});
  expect(result.status).toBe('failed');expect(result.text).toBe('');expect(result.message).toContain('length');expect(calls).toBeLessThanOrEqual(2);
});

test('原生请求错误原样返回失败回执',async()=>{
  setup();let calls=0;
  __setChatTransportForTests(async()=>{calls++;throw new Error('OCR 原生服务错误');});
  const result=await recognizeImageText(engine,createCanvas(64,64).toBuffer('image/png'),'image/png',{enabled:true});
  expect(result).toMatchObject({status:'failed',text:'',message:'OCR 原生服务错误'});expect(calls).toBe(1);
});

test('模型原生拒绝不保存为 OCR 正文，也不切换模型重试',async()=>{
  setup();let calls=0;
  __setChatTransportForTests(async()=>{calls++;return reply('原生服务拒绝内容','refusal');});
  const result=await recognizeImageText(engine,createCanvas(64,64).toBuffer('image/png'),'image/png',{enabled:true});
  expect(result).toMatchObject({status:'failed',text:'',message:'原生服务拒绝内容'});expect(calls).toBe(1);
});

test('无文字图片沿用成功但无文字回执',async()=>{
  setup();__setChatTransportForTests(async()=>reply(''));
  expect(await recognizeImageText(engine,createCanvas(64,64).toBuffer('image/png'),'image/png',{enabled:true})).toMatchObject({status:'success',text:'',code:'no_text'});
});

test('非 PNG 和超过局部解码上限的 PNG 沿用原始输入，取消在解码前生效',async()=>{
  const jpeg=Buffer.from('ordinary JPEG input');
  expect((await ocrImageInputs(jpeg,'image/jpeg'))[0]?.bytes).toBe(jpeg);
  const header=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(header);header.writeUInt32BE(16384,16);header.writeUInt32BE(16384,20);
  expect((await ocrImageInputs(header,'image/png'))[0]?.bytes).toBe(header);
  header.writeUInt32BE(4200,16);header.writeUInt32BE(4100,20);
  await expect(ocrImageInputs(header,'image/png',AbortSignal.abort(new Error('已取消')))).rejects.toThrow('已取消');
});
