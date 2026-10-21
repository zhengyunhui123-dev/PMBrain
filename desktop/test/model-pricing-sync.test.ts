import {expect,test} from 'bun:test';
import {syncServiceModels} from '../src/main/models/model-service-sync';
import type {ModelService} from '../../shared/model-services';
const service:ModelService={id:'mimo',provider:'mimo',name:'MiMo',enabled:true,apiKey:'test-key',baseUrl:'https://api.xiaomimimo.com/v1',models:[]};
test('同步模型同时取得官方人民币价格，不向价格站发送 API 密钥',async()=>{
 const urls:string[]=[];
 const result=await syncServiceModels(service,async(input,init)=>{
  const url=String(input);urls.push(url);
  if(url.endsWith('/models'))return Response.json({data:[{id:'mimo-v2.6-pro'}]});
  expect(new Headers(init?.headers).has('authorization')).toBe(false);
  return new Response('<h4>人民币</h4>输入（缓存命中） ¥ 0.025 输入（缓存未命中） ¥ 3 输出 ¥ 6 <h4>美元</h4>输入（缓存命中） $0.0036 输入（缓存未命中） $0.435 输出 $0.87');
 });
 expect(result.models[0]).toMatchObject({inputPriceCny:3,outputPriceCny:6,pricingSource:'official'});
 expect(urls).toContain('https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go');expect(result.warnings).toEqual([]);
});
test('价格接口失败明确提示，不编造价格，代理平台不套用小米直连价',async()=>{
 const result=await syncServiceModels(service,async input=>String(input).endsWith('/models')?Response.json({data:[{id:'mimo-v2.6-pro'}]}):new Response('unavailable',{status:503}));
 expect(result.models[0].inputPriceCny).toBeUndefined();expect(result.warnings[0]).toContain('价格同步失败');
 let calls=0;await syncServiceModels({...service,baseUrl:'https://proxy.example/v1'},async()=>{calls++;return Response.json({data:[{id:'mimo-v2.6-pro'}]});});expect(calls).toBe(1);
});
