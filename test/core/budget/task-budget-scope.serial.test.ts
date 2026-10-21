import {beforeEach,afterEach,expect,test} from 'bun:test';
import {BudgetTracker,BudgetExhausted} from '../../../src/core/budget/budget-tracker';
import {chat,withBudgetTracker,withTaskBudgetTracker,__setChatTransportForTests,configureGateway,resetGateway} from '../../../src/core/ai/gateway';

beforeEach(()=>configureGateway({env:{},generative_enabled:false}));
afterEach(()=>{__setChatTransportForTests(null);resetGateway();});
const opts={model:'test-billing:model',messages:[{role:'user' as const,content:'资料'}],maxTokens:100};
test('总预算覆盖内部阶段预算，达到上限后不再请求模型',async()=>{
 let calls=0;
 __setChatTransportForTests(async()=>{calls++;return {text:'ok',blocks:[],stopReason:'end',model:opts.model,providerId:'test-billing',usage:{input_tokens:100,output_tokens:100,cache_read_tokens:0,cache_creation_tokens:0}};});
 const pricingOverrides={[opts.model]:{input:1,output:1}};
 const root=new BudgetTracker({label:'test.total',maxCostUsd:0.0004,pricingOverrides});
 const phase=new BudgetTracker({label:'test.phase',maxCostUsd:1,pricingOverrides});
 await withTaskBudgetTracker(root,()=>withBudgetTracker(phase,async()=>{
  await chat(opts);
  await expect(chat(opts)).rejects.toBeInstanceOf(BudgetExhausted);
 }));
 expect(calls).toBe(1);
 expect(root.totalSpent).toBeCloseTo(0.0002,8);
 expect(phase.totalSpent).toBeCloseTo(0.0002,8);
});
test('MiMo 转发服务未设价时不能套用官方原站单价绕过限制',()=>{
 const tracker=new BudgetTracker({label:'test.proxy',maxCostUsd:1,strictModelPricing:true});
 expect(()=>tracker.reserve({modelId:'mimo:mimo-v2.6-pro',kind:'chat',estimatedInputTokens:1,maxOutputTokens:1})).toThrow(BudgetExhausted);
 expect(tracker.stopReason).toBe('no_pricing');
});
test('缓存命中按缓存价计费，未定价模型在请求前停止',async()=>{
 const tracker=new BudgetTracker({label:'test.cny',maxCostUsd:1,pricingOverrides:{'mimo:mimo-v2.6-pro':{input:3/7,output:6/7,cache_read:0.025/7}}});
 tracker.record({modelId:'mimo:mimo-v2.6-pro',inputTokens:1_000_000,outputTokens:1_000_000,cacheReadTokens:900_000});
 expect(tracker.totalSpent*7).toBeCloseTo(6.3225,6);
 expect(()=>tracker.reserve({modelId:'unpriced:model',kind:'chat',estimatedInputTokens:1,maxOutputTokens:1})).toThrow(BudgetExhausted);
});
test('并行请求先占预算，重启时保留已用金额及未确认预留',()=>{
 const tracker=new BudgetTracker({label:'test.concurrent',maxCostUsd:0.2,initialCostUsd:0.05,reserveInFlight:true,pricingOverrides:{'priced:model':{input:1,output:1}}});
 tracker.reserve({modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'a'});
 expect(()=>tracker.reserve({modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'b'})).toThrow(BudgetExhausted);
 tracker.record({modelId:'priced:model',inputTokens:80_000,reservationId:'a'});
 expect(tracker.totalSpent).toBeCloseTo(0.13,8);
 expect(tracker.snapshot().reservedCostUsd).toBe(0);
});
