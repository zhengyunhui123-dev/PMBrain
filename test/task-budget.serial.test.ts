import {beforeAll,afterAll,expect,test,setDefaultTimeout} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PGLiteEngine} from '../src/core/pglite-engine';
import type {BrainEngine} from '../src/core/engine';
import {MinionQueue} from '../src/core/minions/queue';
import {handleTaskBudget,openTaskBudget} from '../src/product/tasks/task-budget';
import {runWithDreamBudget} from '../src/product/tasks/dream-budget';
import {chat,embed,withTaskBudgetTracker,__setChatTransportForTests,configureGateway,resetGateway} from '../src/core/ai/gateway';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';

setDefaultTimeout(60_000);
let engine:BrainEngine,queue:MinionQueue,home:string;
const oldHome=process.env.PMBRAIN_HOME;
beforeAll(async()=>{
 home=mkdtempSync(join(tmpdir(),'pmbrain-task-budget-test-'));mkdirSync(join(home,'.pmbrain'));writeFileSync(join(home,'.pmbrain/config.json'),'{}');process.env.PMBRAIN_HOME=home;
 if(process.env.PMBRAIN_BUDGET_TEST_POSTGRES==='1'){const url=process.env.DATABASE_URL??'';assertSafeE2eDatabaseUrl(url);const {PostgresEngine}=await import('../src/core/postgres-engine');engine=new PostgresEngine();await engine.connect({database_url:url});}else{engine=new PGLiteEngine();await engine.connect({});}
 await engine.initSchema();queue=new MinionQueue(engine);
 await engine.setConfig('pricing.usd_to_cny','7');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1}}));
},120_000);
afterAll(async()=>{__setChatTransportForTests(null);resetGateway();await engine.disconnect();if(oldHome===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=oldHome;if(home.startsWith(join(tmpdir(),'pmbrain-task-budget-test-')))rmSync(home,{recursive:true,force:true});});
async function job(sessionId?:number){
 const token=crypto.randomUUID();
 const added=await queue.add('task-budget-test',{kind:sessionId?'sync_file':'dream_full',...(sessionId?{sessionId}:{}),task:sessionId?{type:'sync-file',input:{}}:{type:'dream',input:{preset:'full'}}},{queue:'task-budget-test'});
 const claimed=await queue.claim(token,60_000,'task-budget-test',['task-budget-test']);expect(claimed?.id).toBe(added.id);
 return {id:added.id,token,call:(request:Parameters<typeof handleTaskBudget>[3])=>handleTaskBudget(engine,added.id,token,request)};
}
test('主任务和同步子任务共享人民币预算，继续原任务累计费用不清零',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');
 const root=await job();const child=await job(root.id);
 await root.call({operation:'init'});
 expect((await root.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'a'}})).denied).toBeUndefined();
 expect((await child.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'b'}})).denied).toBe('cost');
 const settled=await root.call({operation:'record',usage:{modelId:'priced:model',inputTokens:80_000,reservationId:'a'}});
 expect(settled.state.spentCny).toBeCloseTo(0.56,8);expect(settled.state.reservedCny).toBe(0);
 await engine.setConfig('dream.task_budget_cny','2');
 const resumed=await root.call({operation:'init'});expect(resumed.state.capCny).toBe(2);expect(resumed.state.spentCny).toBeCloseTo(0.56,8);expect(resumed.state.reason).toBeUndefined();
 expect((await child.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:200_000,maxOutputTokens:0,reservationId:'c'}})).denied).toBeUndefined();
 await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id=$1",[root.id]);
 let stopped:unknown;try{await child.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:1,maxOutputTokens:0,reservationId:'d'}});}catch(error){stopped=error;}
 expect(stopped).toBeInstanceOf(Error);expect(String(stopped)).toContain('原整理任务已停止');
});
test('预算预留持久化且只结算一次，中断未确认用量不会被清零',async()=>{
 await engine.setConfig('dream.task_budget_cny','10');const root=await job();await root.call({operation:'init'});
 const ticket={modelId:'priced:model',kind:'chat' as const,estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'pending'};
 await root.call({operation:'reserve',estimate:ticket});
 expect((await root.call({operation:'init'})).state.reservedCny).toBeCloseTo(0.7,8);
 const usage={modelId:'priced:model',inputTokens:90_000,reservationId:'pending'};
 expect((await root.call({operation:'record',usage})).state.spentCny).toBeCloseTo(0.63,8);
 expect((await root.call({operation:'record',usage})).state.spentCny).toBeCloseTo(0.63,8);
});
test('真实 Gateway 的未设置价格模型不受费用上限限制，未知费用不计为零成本',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');const root=await job();const tracker=await openTaskBudget(root.call);let calls=0;
 __setChatTransportForTests(async()=>{calls++;return {text:'完成',blocks:[],stopReason:'end',model:'unpriced:model',providerId:'unpriced',usage:{input_tokens:100,output_tokens:20,cache_read_tokens:0,cache_creation_tokens:0}};});
 await withTaskBudgetTracker(tracker!,()=>chat({model:'unpriced:model',messages:[{role:'user',content:'资料'}],maxTokens:20}));
 expect(calls).toBe(1);expect(tracker?.value.reason).toBeUndefined();expect(tracker?.value.unpricedCostUnknown).toBe(true);expect(tracker?.value.calls).toBe(1);expect(tracker?.value.reservedCny).toBe(0);
});

test('本地模型即使设置单价也不受费用上限限制，真实付费模型仍受上限约束',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');
 await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1},'ollama:local':{input:100,output:100},'custom-openai:local':{input:100,output:100}}));
 const path=join(home,'.pmbrain/config.json');writeFileSync(path,JSON.stringify({desktop:{model_services:[{id:'local',provider:'custom-openai',name:'本地模型',enabled:true,baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',models:[{id:'local',name:'local',kind:'chat',group:'local',capabilities:[],inputPriceCny:100,outputPriceCny:100}]}]}}));
 try{
  const root=await job();await root.call({operation:'init'});
  for(const modelId of ['ollama:local','custom-openai:local']){
   const reservationId=`local-${modelId}`;const reserved=await root.call({operation:'reserve',estimate:{modelId,kind:'chat',estimatedInputTokens:2_000_000,maxOutputTokens:0,reservationId}});
   expect(reserved.denied).toBeUndefined();
   const completed=await root.call({operation:'record',usage:{modelId,inputTokens:2_000_000,reservationId}});
   expect(completed.state.spentCny).toBe(0);expect(completed.state.unpricedCostUnknown).not.toBe(true);
  }
  expect((await root.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:200_000,maxOutputTokens:0,reservationId:'paid'}})).denied).toBe('cost');
 }finally{writeFileSync(path,'{}');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1}}));}
});

test('模型设置没有单价时不套用内置价格，已用预算超过新上限后仍可使用未定价模型',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1}}));
 const root=await job();await root.call({operation:'init'});
 await root.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'paid'}});
 await root.call({operation:'record',usage:{modelId:'priced:model',inputTokens:100_000,reservationId:'paid'}});
 await engine.setConfig('dream.task_budget_cny','0.5');
 const unpriced=await root.call({operation:'reserve',estimate:{modelId:'anthropic:claude-sonnet-4-6',kind:'chat',estimatedInputTokens:1_000_000,maxOutputTokens:0,reservationId:'unpriced'}});
 expect(unpriced.denied).toBeUndefined();expect(unpriced.state.unpricedCostUnknown).toBe(true);
 await root.call({operation:'record',usage:{modelId:'anthropic:claude-sonnet-4-6',inputTokens:1_000_000,reservationId:'unpriced'}});
 let calls=0;__setChatTransportForTests(async()=>{calls++;return {text:'完成',blocks:[],stopReason:'end',model:'unpriced:model',providerId:'unpriced',usage:{input_tokens:10,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0}};});
 try{
  const result=await runWithDreamBudget({},async()=>{await chat({model:'unpriced:model',messages:[{role:'user',content:'资料'}],maxTokens:20});return {status:'ok'};},root.call);
  expect(result.status).toBe('ok');expect(calls).toBe(1);expect((result.budget as any).unpricedCostUnknown).toBe(true);
 }finally{__setChatTransportForTests(null);}
});

test('模型设置只有部分价格时不限制，输入与输出价格完整后按上限控制',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');const path=join(home,'.pmbrain/config.json');
 await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1},'custom-openai:partial':{input:100,output:100},'custom-openai:priced':{input:0.01,output:0.01}}));
 const model=(id:string,prices:Record<string,number>)=>({id,name:id,kind:'chat',group:'test',capabilities:[],...prices});
 writeFileSync(path,JSON.stringify({desktop:{model_services:[{id:'remote',provider:'custom-openai',name:'远程',enabled:true,baseUrl:'https://fixture.invalid/v1',apiKey:'test-only',models:[model('partial',{inputPriceCny:1}),model('priced',{inputPriceCny:1,outputPriceCny:2})]}]}}));
 try{
  const root=await job();await root.call({operation:'init'});
  const partial=await root.call({operation:'reserve',estimate:{modelId:'custom-openai:partial',kind:'chat',estimatedInputTokens:2_000_000,maxOutputTokens:0,reservationId:'partial'}});
  expect(partial.denied).toBeUndefined();expect(partial.state.unpricedCostUnknown).toBe(true);
  await root.call({operation:'record',usage:{modelId:'custom-openai:partial',inputTokens:2_000_000,reservationId:'partial'}});
  const priced=await root.call({operation:'reserve',estimate:{modelId:'custom-openai:priced',kind:'chat',estimatedInputTokens:2_000_000,maxOutputTokens:0,reservationId:'priced'}});
  expect(priced.denied).toBe('cost');
 }finally{writeFileSync(path,'{}');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1}}));}
});

test('付费云模型经本机转发时仍按设置价格控制预算',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');const path=join(home,'.pmbrain/config.json');
 writeFileSync(path,JSON.stringify({desktop:{model_services:[{id:'mimo',provider:'mimo',name:'MiMo 转发',enabled:true,baseUrl:'http://127.0.0.1:9999/v1',apiKey:'test-only',models:[{id:'relay',name:'relay',kind:'chat',group:'test',capabilities:[],inputPriceCny:1,outputPriceCny:2}]}]}}));
 try{
  const root=await job();await root.call({operation:'init'});
  const result=await root.call({operation:'reserve',estimate:{modelId:'mimo:relay',kind:'chat',estimatedInputTokens:2_000_000,maxOutputTokens:0,reservationId:'relay'}});
  expect(result.denied).toBe('cost');expect(result.state.unpricedCostUnknown).not.toBe(true);
 }finally{writeFileSync(path,'{}');}
});
test('OpenAI 兼容用量中的缓存 Token 按人民币缓存价结算',async()=>{
 __setChatTransportForTests(null);
 await engine.setConfig('dream.task_budget_cny','10');const root=await job();const tracker=await openTaskBudget(root.call);
 const path=join(home,'.pmbrain/config.json');writeFileSync(path,JSON.stringify({desktop:{model_services:[{id:'mimo',provider:'mimo',name:'MiMo',enabled:true,baseUrl:'https://api.xiaomimimo.com/v1',apiKey:'test-only',models:[{id:'mimo-v2.6-pro',name:'mimo-v2.6-pro',kind:'chat',group:'MiMo',capabilities:[]}]}]}}));
 const server=Bun.serve({port:0,fetch:()=>Response.json({id:'billing-test',object:'chat.completion',created:1,model:'mimo-v2.6-pro',choices:[{index:0,message:{role:'assistant',content:'已整理'},finish_reason:'stop'}],usage:{prompt_tokens:1_000_000,completion_tokens:100_000,total_tokens:1_100_000,prompt_tokens_details:{cached_tokens:900_000}}})});
 configureGateway({env:{MIMO_API_KEY:'test-only'},base_urls:{mimo:`http://127.0.0.1:${server.port}/v1`},generative_enabled:true});
 try{await withTaskBudgetTracker(tracker!,()=>chat({model:'mimo:mimo-v2.6-pro',messages:[{role:'user',content:'资料'}],maxTokens:1000}));expect(tracker!.value.spentCny).toBeCloseTo(0.9225,6);expect(tracker!.value.reservedCny).toBe(0);}finally{writeFileSync(path,'{}');server.stop(true);resetGateway();}
});
test('没有返回用量的请求保留预留额，不会按零费用放行',async()=>{
 await engine.setConfig('dream.task_budget_cny','10');const root=await job();await root.call({operation:'init'});
 await root.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'unknown'}});
 const reply=await root.call({operation:'record',usage:{modelId:'priced:model',inputTokens:0,outputTokens:0,usageMissing:true,reservationId:'unknown'}});
 expect(reply.state.spentCny).toBe(0);expect(reply.state.reservedCny).toBeCloseTo(0.7,8);
});
test('向量费用使用服务商返回的 Token 用量，不以字符数冒充实际用量',async()=>{
 await engine.setConfig('dream.task_budget_cny','10');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1},'custom-openai:fixture-embed':{input:1,output:0}}));
 const root=await job(),tracker=await openTaskBudget(root.call);
 const server=Bun.serve({port:0,async fetch(req){const body=await req.json() as {input:string[]};return Response.json({object:'list',model:'fixture-embed',data:body.input.map((_,index)=>({object:'embedding',index,embedding:Array(1536).fill(0.1)})),usage:{prompt_tokens:1234,total_tokens:1234}});}});
 configureGateway({embedding_model:'custom-openai:fixture-embed',embedding_dimensions:1536,env:{CUSTOM_OPENAI_API_KEY:'test-only'},base_urls:{'custom-openai':`http://127.0.0.1:${server.port}/v1`}});
 try{await withTaskBudgetTracker(tracker!,()=>embed(['验收']));expect(tracker!.value.spentCny).toBeCloseTo(0.008638,8);expect(tracker!.value.reservedCny).toBe(0);}finally{server.stop(true);resetGateway();}
});
test('请求发出后同步了新单价，已有请求仍按领取时的价格结算',async()=>{
 await engine.setConfig('dream.task_budget_cny','10');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1}}));
 const root=await job();await root.call({operation:'init'});
 await root.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'quoted'}});
 await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:9,output:9}}));
 const settled=await root.call({operation:'record',usage:{modelId:'priced:model',inputTokens:100_000,reservationId:'quoted'}});
 expect(settled.state.spentCny).toBeCloseTo(0.7,8);
 await root.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'new'}});
 expect((await root.call({operation:'record',usage:{modelId:'priced:model',inputTokens:100_000,reservationId:'new'}})).state.spentCny).toBeCloseTo(7,8);
});

test('两个同步子任务同时领取预算时只能放行余额允许的一次请求',async()=>{
 await engine.setConfig('dream.task_budget_cny','1');await engine.setConfig('pricing.overrides',JSON.stringify({'priced:model':{input:1,output:1}}));
 const root=await job(),children=[await job(root.id),await job(root.id)];await root.call({operation:'init'});
 const replies=await Promise.all(children.map((child,index)=>child.call({operation:'reserve',estimate:{modelId:'priced:model',kind:'chat',estimatedInputTokens:100_000,maxOutputTokens:0,reservationId:'parallel-'+index}})));
 expect(replies.filter(reply=>reply.denied===undefined)).toHaveLength(1);expect(replies.filter(reply=>reply.denied==='cost')).toHaveLength(1);
 const accepted=replies.findIndex(reply=>reply.denied===undefined);
 const settled=await children[accepted]!.call({operation:'record',usage:{modelId:'priced:model',inputTokens:80_000,reservationId:'parallel-'+accepted}});
 expect(settled.state.spentCny).toBeCloseTo(0.56,8);expect(settled.state.reservedCny).toBe(0);
});
