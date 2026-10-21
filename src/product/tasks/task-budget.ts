import type {BrainEngine} from '../../core/engine';
import {BudgetTracker,BudgetExhausted,loadPricingOverrides,type BudgetEstimate,type BudgetActualUsage,type BudgetSnapshot,type BudgetReason} from '../../core/budget/budget-tracker';
import {DEFAULT_DREAM_BUDGET_CNY,DEFAULT_USD_TO_CNY} from '../../../shared/model-billing';
import type {ModelPricing} from '../../core/model-pricing';

export interface TaskBudgetState{capCny:number;spentCny:number;reservedCny:number;usdToCny:number;calls:number;reason?:BudgetReason;historicalCostUnknown?:boolean;revision?:number;reservations?:Record<string,number>;pendingPricing?:Record<string,ModelPricing>}
export type TaskBudgetRequest={operation:'init'|'reserve'|'record';estimate?:BudgetEstimate;usage?:BudgetActualUsage&{kind?:'chat'|'embed'|'rerank'}};
export interface TaskBudgetReply{state:TaskBudgetState;disabled?:boolean;denied?:BudgetReason;message?:string}
export function taskBudgetMessage(reason:BudgetReason):string{return reason==='no_pricing'?'模型价格未设置，已停止付费请求；请同步模型价格或填写单价后继续':'剩余费用预算不足，已保存成果；提高整次上限后可继续';}

export async function handleTaskBudget(engine:BrainEngine,jobId:number,token:string,request:TaskBudgetRequest):Promise<TaskBudgetReply>{
 return engine.transaction(async tx=>{
  const [own]=await tx.executeRaw<{data:any;status:string;lock_token:string;lock_until:Date}>('SELECT data,status,lock_token,lock_until FROM minion_jobs WHERE id=$1 FOR UPDATE',[jobId]);
  if(!own||own.status!=='active'||own.lock_token!==token||!own.lock_until||new Date(own.lock_until).getTime()<=Date.now())throw new Error('任务已停止或预算租约失效');
  const rootId=own.data.task?.type==='sync-file'?Number(own.data.sessionId):jobId;
  const [root]=rootId===jobId?[own]:await tx.executeRaw<typeof own>('SELECT data,status,lock_token,lock_until FROM minion_jobs WHERE id=$1 FOR UPDATE',[rootId]);
  if(root?.data.task?.type==='import')return {disabled:true,state:{capCny:0,usdToCny:DEFAULT_USD_TO_CNY,spentCny:0,reservedCny:0,calls:0}};
  if(!root||root.data.task?.type!=='dream'||!['active','waiting','waiting-children'].includes(root.status))throw new Error('原整理任务已停止，未发起付费请求');
  const previous=root.data.taskBudget as TaskBudgetState|undefined;
  const capCny=request.operation==='init'&&rootId===jobId||!previous?Number(await tx.getConfig('dream.task_budget_cny')??DEFAULT_DREAM_BUDGET_CNY):previous.capCny;
  const usdToCny=previous?.usdToCny??Number(await tx.getConfig('pricing.usd_to_cny')??DEFAULT_USD_TO_CNY);
  if(!Number.isFinite(capCny)||capCny<=0||!Number.isFinite(usdToCny)||usdToCny<=0)throw new Error('整理费用上限或汇率无效');
  const reservations={...previous?.reservations};
  const rawId=request.estimate?.reservationId??request.usage?.reservationId;
  const reservationId=rawId?`${jobId}:${token}:${rawId}`:undefined;
  const pendingPricing={...previous?.pendingPricing};
  const pricingOverrides=await loadPricingOverrides(tx,usdToCny)??{};
  if(request.operation==='record'&&reservationId&&request.usage&&pendingPricing[reservationId])pricingOverrides[request.usage.modelId.toLowerCase()]=pendingPricing[reservationId]!;
  const tracker=new BudgetTracker({label:'dream.total',maxCostUsd:capCny/usdToCny,initialCostUsd:(previous?.spentCny??0)/usdToCny,reserveInFlight:true,strictModelPricing:true,initialReservations:Object.fromEntries(Object.entries(reservations).map(([id,cny])=>[id,cny/usdToCny])),pricingOverrides});
  let denied:BudgetReason|undefined;
  try{
   if(request.operation==='reserve'){
    if(!reservationId||!request.estimate)throw new Error('无效的费用预留');
    if(previous?.reason)throw new BudgetExhausted(taskBudgetMessage(previous.reason),{reason:previous.reason,spent:tracker.totalSpent,cap:tracker.cap??0});
    tracker.reserve({...request.estimate,reservationId});
    const price=tracker.pricingFor(request.estimate.modelId,request.estimate.kind);if(price)pendingPricing[reservationId]={...price};
   }else if(request.operation==='record'){
    if(!reservationId||!request.usage)throw new Error('无效的费用结算');
    if(reservations[reservationId]!==undefined)tracker.record({...request.usage,reservationId});
   }
  }catch(error){if(error instanceof BudgetExhausted)denied=error.reason;else throw error;}
  const snapshot=tracker.snapshot();
  const historicalCostUnknown=previous?.historicalCostUnknown??(!previous&&Object.values(root.data.task.input?.checkpoint?.phases??{}).some(phases=>Array.isArray(phases)&&phases.length>0));
  const pending=tracker.pendingReservations();
  const state:TaskBudgetState={capCny,usdToCny,spentCny:snapshot.cumulativeCostUsd*usdToCny,reservedCny:(snapshot.reservedCostUsd??0)*usdToCny,calls:(previous?.calls??0)+snapshot.callsRecorded,historicalCostUnknown,revision:(previous?.revision??0)+1,reservations:Object.fromEntries(Object.entries(pending).map(([id,usd])=>[id,usd*usdToCny])),pendingPricing:Object.fromEntries(Object.entries(pendingPricing).filter(([id])=>Object.hasOwn(pending,id))),reason:denied??(request.operation==='init'&&rootId===jobId?undefined:previous?.reason)};
  await tx.executeRaw("UPDATE minion_jobs SET data=jsonb_set(data,'{taskBudget}',$2::jsonb),updated_at=now() WHERE id=$1",[rootId,state]);
  return {state,denied,message:denied?taskBudgetMessage(denied):undefined};
 });
}

export class RemoteTaskBudget extends BudgetTracker{
 private operations:Promise<void>=Promise.resolve();
 private failure:unknown;
 constructor(private state:TaskBudgetState,private readonly request:(request:TaskBudgetRequest)=>Promise<TaskBudgetReply>){super({label:'dream.total.remote'});}
 get value():TaskBudgetState{const {reservations,pendingPricing,...view}=this.state;return view;}
 override get totalSpent():number{return this.state.spentCny/this.state.usdToCny;}
 override get cap():number{return this.state.capCny/this.state.usdToCny;}
 override get stopReason():BudgetReason|undefined{return this.state.reason;}
 override snapshot():BudgetSnapshot{return {cumulativeCostUsd:this.totalSpent,reservedCostUsd:this.state.reservedCny/this.state.usdToCny,maxCostUsd:this.cap,callsRecorded:this.state.calls,startedAt:0,elapsedMs:0,stopReason:this.stopReason};}
 private enqueue(request:TaskBudgetRequest):void{this.operations=this.operations.then(async()=>{try{const reply=await this.request(request);this.state=reply.state;if(reply.denied&&request.operation!=='record')this.failure=new BudgetExhausted(reply.message??taskBudgetMessage(reply.denied),{reason:reply.denied,spent:this.totalSpent,cap:this.cap});}catch(error){this.failure=error;}});}
 override reserve(estimate:BudgetEstimate):void{if(this.stopReason)throw new BudgetExhausted(taskBudgetMessage(this.stopReason),{reason:this.stopReason,spent:this.totalSpent,cap:this.cap});this.enqueue({operation:'reserve',estimate});}
 override record(usage:BudgetActualUsage&{kind?:'chat'|'embed'|'rerank'}):void{this.enqueue({operation:'record',usage});}
 override affordableOutputTokens(estimate:BudgetEstimate):number{return estimate.maxOutputTokens;}
 override async flush():Promise<void>{await this.operations;if(this.failure){const error=this.failure;this.failure=undefined;throw error;}}
}
export async function openTaskBudget(request:(request:TaskBudgetRequest)=>Promise<TaskBudgetReply>):Promise<RemoteTaskBudget|null>{const reply=await request({operation:'init'});return reply.disabled?null:new RemoteTaskBudget(reply.state,request);}
