import {afterEach,expect,test} from 'bun:test';
import {createCanvas} from '@napi-rs/canvas';
import {configureGateway,resetGateway,__setChatTransportForTests,generateOcrText,type ChatResult,type ChatOpts} from '../src/core/ai/gateway';
import {generateOcrBatch} from '../src/core/pmbrain-adapters/ocr-batch';
import {recognizeImageText} from '../src/core/ocr';
import {ocrImageInputs} from '../src/core/ocr-images';
import {createDocumentOcr} from '../src/core/document/ocr-cache';

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

test('多页扫描图一次请求并按原页码分别返回文字',async()=>{
  setup();let calls=0,options:ChatOpts|undefined;
  __setChatTransportForTests(async opts=>{calls++;options=opts;return reply('```json\n[{"id":"9","text":"第九页原文"},{"id":"7","text":"第七页原文"}]\n```');});
  const image=createCanvas(64,64).toBuffer('image/png');
  const result=await generateOcrBatch([{id:'7',bytes:image,mime:'image/png'},{id:'9',bytes:image,mime:'image/png'}]);
  expect(calls).toBe(1);expect(result).toEqual(['第七页原文','第九页原文']);
  const parts=options!.messages[0]!.content as any[];
  expect(parts.filter(part=>part.type==='image')).toHaveLength(2);
  expect(options!.system).toContain('Do NOT interpret');
});

test('合并识图结果缺页、重复页码或截断时不保存不完整文字',async()=>{
  setup();const image=createCanvas(64,64).toBuffer('image/png'),items=[{id:'1',bytes:image,mime:'image/png'},{id:'2',bytes:image,mime:'image/png'}];
  for(const text of ['[{"id":"1","text":"一"}]','[{"id":"1","text":"一"},{"id":"1","text":"二"}]','{"pages":[{"id":"1","text":"一"},{"id":"3","text":"三"}]}']){
    __setChatTransportForTests(async()=>reply(text));
    await expect(generateOcrBatch(items)).rejects.toThrow('识图');
  }
  __setChatTransportForTests(async()=>reply('partial','length'));
  await expect(generateOcrBatch(items)).rejects.toThrow('截断');
});

test('同一批次的重复图片只识别一次，成功缓存供再次整理使用',async()=>{
  const store=new Map<string,string>();
  const cacheEngine={getConfig:async(key:string)=>store.get(key)??null,setConfig:async(key:string,value:string)=>{store.set(key,value);}} as any;
  let singleCalls=0,batchCalls=0;
  const imageA=Buffer.from('image-a'),imageB=Buffer.from('image-b');
  const recognize=createDocumentOcr(cacheEngine,'same-source',async()=>{singleCalls++;return {status:'success',text:'single',model:'fixture'};},true,async inputs=>{
    batchCalls++;return inputs.map(input=>({status:'success',text:`text-${input.id}`,model:'fixture'}));
  });
  const items=[{page:1,image:imageA,mime:'image/png'},{page:2,image:imageB,mime:'image/png'},{page:3,image:imageA,mime:'image/png'}];
  const first=await recognize.batch!(items);
  expect(batchCalls).toBe(1);expect(singleCalls).toBe(0);expect(first[2].text).toBe(first[0].text);expect(first[2].reused).toBe(true);
  const again=await recognize.batch!(items);
  expect(batchCalls).toBe(1);expect(singleCalls).toBe(0);expect(again.every(item=>item.reused)).toBe(true);
});

test('并发识图出现错误时等待另一请求结束后再退出',async()=>{
  const store=new Map<string,string>();
  const cacheEngine={getConfig:async(key:string)=>store.get(key)??null,setConfig:async(key:string,value:string)=>{store.set(key,value);}} as any;
  let release!:()=>void,settled=false;const held=new Promise<void>(resolve=>{release=resolve;});
  const recognize=createDocumentOcr(cacheEngine,'wait-inflight',async image=>{
    if(image.toString()==='error')throw new Error('识图失败');
    await held;settled=true;return {status:'success',text:'saved',model:'fixture'};
  });
  const pending=recognize.batch!([{page:1,image:Buffer.from('error'),mime:'image/png'},{page:2,image:Buffer.from('held'),mime:'image/png'}]);
  let rejected=false;void pending.catch(()=>{rejected=true;});await Bun.sleep(10);expect(rejected).toBe(false);
  release();await expect(pending).rejects.toThrow('识图失败');expect(settled).toBe(true);
});

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
test('显式关闭识图优先于全局已有模型配置，不发请求',async()=>{
  setup();let calls=0;__setChatTransportForTests(async()=>{calls++;return reply('不应调用');});
  const result=await recognizeImageText(engine,createCanvas(64,64).toBuffer('image/png'),'image/png',{enabled:false});
  expect(result).toMatchObject({status:'skipped',code:'disabled'});expect(calls).toBe(0);
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

test('图片请求被拒绝时保留服务商具体原因，不只显示 Bad Request', async () => {
  setup();
  __setChatTransportForTests(async () => { throw Object.assign(new Error('Bad Request'), { cause: { responseBody: JSON.stringify({ error: { message: 'This model does not support image inputs' } }) } }); });
  const result = await recognizeImageText(engine, createCanvas(64,64).toBuffer('image/png'), 'image/png', { enabled: true });
  expect(result.status).toBe('failed');
  expect(result.message).toContain('This model does not support image inputs');
});

test('真实兼容 SDK 的 HTTP 400 响应保留图片拒绝原因且不重试其他模型', async () => {
  let requests = 0;
  server = Bun.serve({ port: 0, fetch: () => { requests++; return Response.json({ error: { message: 'Image inputs are not supported by this model', type: 'invalid_request_error' } }, { status: 400 }); } });
  configureGateway({ chat_model: 'service-ocr:fixture', base_urls: { 'service-ocr': server.url.origin + '/v1' }, touchpoint_api_keys: { 'service-ocr': { chat: 'fixture-only' } }, env: {} });
  const result = await recognizeImageText(engine, createCanvas(64,64).toBuffer('image/png'), 'image/png', { enabled: true });
  expect(result.status).toBe('failed');
  expect(result.message).toContain('Image inputs are not supported by this model');
  expect(requests).toBe(1);
});

test('已知不支持图片的硅基流动型号在发起模型请求前说明原因', async () => {
  configureGateway({ chat_model: 'service-siliconflow:deepseek-ai/DeepSeek-V4-Flash', base_urls: { 'service-siliconflow': 'https://api.siliconflow.cn/v1' }, touchpoint_api_keys: { 'service-siliconflow': { chat: 'fixture-only' } }, env: {} });
  let calls = 0;
  __setChatTransportForTests(async () => { calls++; return reply('unexpected'); });
  const result = await recognizeImageText(engine, createCanvas(64,64).toBuffer('image/png'), 'image/png', { enabled: true });
  expect(result).toMatchObject({ status: 'skipped', code: 'model_no_vision' });
  expect(result.message).toContain('不支持图片输入');
  expect(calls).toBe(0);
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
