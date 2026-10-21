import type {DreamTaskInput} from './types';
import {BudgetExhausted} from '../../core/budget/budget-tracker';
import {withTaskBudgetTracker,getTaskBudgetTracker} from '../../core/ai/gateway';
import {openTaskBudget,taskBudgetMessage,type TaskBudgetRequest,type TaskBudgetReply} from './task-budget';

export async function runWithDreamBudget(input:DreamTaskInput,run:()=>Promise<Record<string,unknown>>,request:(request:TaskBudgetRequest)=>Promise<TaskBudgetReply>):Promise<Record<string,unknown>>{
 if(input.dryRun)return run();
 const checkpoint=input.checkpoint??={phases:{},reports:{}};
 const tracker=await openTaskBudget(request);
 if(!tracker)return run();
 const started=Date.now();
 return withTaskBudgetTracker(tracker,async()=>{
  try{
   if(tracker.value.spentCny+tracker.value.reservedCny>=tracker.value.capCny)throw new BudgetExhausted(taskBudgetMessage('cost'),{reason:'cost',spent:tracker.totalSpent,cap:tracker.cap});
   const result=await run();
   return {...result,budget:tracker.value};
  }catch(error){
   if(!tracker.stopReason&&!(error instanceof BudgetExhausted))throw error;
   await tracker.flush();
   const reason=tracker.stopReason??'cost';
   const phases=Object.values(checkpoint.phases).flat();
   if(phases.length){const last=phases.at(-1)!;last.status='warn';last.details={...last.details,task_budget_stopped:true};}
   return {status:'failed',reason:'task_budget',summary:taskBudgetMessage(reason),budget:{...tracker.value,reason},phases,duration_ms:Date.now()-started};
  }
 });
}
export async function checkDreamBudget():Promise<void>{
 const tracker=getTaskBudgetTracker();
 if(!tracker)return;
 await tracker.flush();
 if(tracker.stopReason)throw new BudgetExhausted(taskBudgetMessage(tracker.stopReason),{reason:tracker.stopReason,spent:tracker.totalSpent,cap:tracker.cap??0});
}
