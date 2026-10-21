import {expect,test} from 'bun:test';
import {modelBilling,parseMiMoPricing,mergeModelBilling} from '../shared/model-billing';
import {newServiceModel,type ModelService} from '../shared/model-services';

const service:ModelService={id:'mimo',provider:'mimo',name:'MiMo',baseUrl:'https://api.xiaomimimo.com/v1',apiKey:'',enabled:true,models:[]};
test('官方人民币价优先于旧的通用美元参考价，代理地址不冒用直连价',()=>{
 const model={...newServiceModel('mimo-v2.6-pro'),inputPrice:1.25,outputPrice:10};
 expect(modelBilling(service,model,7)).toMatchObject({inputCny:3,outputCny:6,cacheReadCny:0.025});
 expect(modelBilling({...service,baseUrl:'https://proxy.example/v1'},model,7)).toBeNull();
 expect(modelBilling(service,{...model,inputPriceCny:4,outputPriceCny:8},7)).toMatchObject({inputCny:4,outputCny:8});
});
test('同步解析官方人民币与美元价格，不把缓存价当成普通输入价',()=>{
 const html='<h4>人民币</h4><span>输入（缓存命中）</span><b>¥ 0.025</b><span>输入（缓存未命中）</span><b>¥ 3</b><span>输出</span><b>¥ 6</b><h4>美元</h4><span>输入（缓存命中）</span><b>$0.0036</b><span>输入（缓存未命中）</span><b>$0.435</b><span>输出</span><b>$0.87</b>';
 expect(parseMiMoPricing(html,'mimo-v2.6-pro')).toMatchObject({inputPriceCny:3,outputPriceCny:6,cacheReadPriceCny:0.025,inputPrice:0.435,outputPrice:0.87});
 expect(()=>parseMiMoPricing('<p>暂时不可用</p>','mimo-v2.6-pro')).toThrow();
});
test('同步更新自动价格并保留人工价格',()=>{
 const remote={...newServiceModel('mimo-v2.6-pro'),inputPriceCny:3,outputPriceCny:6,pricingSource:'official' as const};
 expect(mergeModelBilling({...remote,inputPriceCny:9},remote).inputPriceCny).toBe(3);
 expect(mergeModelBilling({...remote,inputPriceCny:9,pricingSource:'manual'},remote).inputPriceCny).toBe(9);
});
