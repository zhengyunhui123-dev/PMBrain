import {cpus,freemem,totalmem} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {memoryPressure,type MemorySample} from '../../../shared/memory-budget.ts';
import {MAX_STREAMED_OFFICE_BYTES} from '../../../shared/document-limits.ts';

const mib=1024**2;
export interface DocumentResourceSample extends MemorySample {cpuBusyRatio?:number|null}
export function documentResourcePlan(sample:DocumentResourceSample){
  const pressure=memoryPressure(sample);
  const available=Math.min(sample.availableBytes,sample.commitHeadroomBytes??Infinity);
  const constrained=pressure.level!=='normal'||available<2*1024**3||(sample.cpuBusyRatio??0)>=0.8;
  const workingBudget=Math.min(pressure.budgetBytes,Math.max(256*mib,available/2));
  return {waiting:pressure.level==='critical',reason:pressure.reason,concurrency:constrained?1:2,batchSize:constrained?16:100,rows:constrained?32:200,
    delayMs:constrained?50:0,maxFileBytes:Math.min(MAX_STREAMED_OFFICE_BYTES,Math.max(64*mib,workingBudget/8)),
    maxExpandedBytes:Math.min(1024*mib,Math.max(128*mib,workingBudget/4)),
    maxTextBytes:Math.min(64*mib,Math.max(8*mib,workingBudget/32)),maxRecordBytes:16*mib};
}
export function sampleDocumentResources():DocumentResourceSample{
  return {bytes:process.memoryUsage().rss,availableBytes:freemem(),totalBytes:totalmem()};
}
export function officeFileSizeLimit(path=''){
  const dynamic=documentResourcePlan(sampleDocumentResources()).maxFileBytes;
  return /\.(?:doc|ppt|wps|xls)$/i.test(path)?Math.min(50*mib,dynamic):dynamic;
}
export interface DocumentRuntimeOptions {signal?:AbortSignal;sample?:()=>DocumentResourceSample|Promise<DocumentResourceSample>}
export class DocumentRuntime {
  private work=0;
  private cpu?:{idle:number;total:number};
  plan=documentResourcePlan(sampleDocumentResources());
  constructor(private options:DocumentRuntimeOptions={}){}
  get signal(){return this.options.signal;}
  async checkpoint(force=false){
    this.signal?.throwIfAborted();
    if(!force&&++this.work<this.plan.rows)return;
    this.work=0;
    for(;;){
      this.signal?.throwIfAborted();
      let sample:DocumentResourceSample;
      if(this.options.sample)sample=await this.options.sample();
      else{
        sample=sampleDocumentResources();
        const next=cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
        if(this.cpu&&next.total>this.cpu.total)sample.cpuBusyRatio=1-(next.idle-this.cpu.idle)/(next.total-this.cpu.total);
        this.cpu=next;
      }
      this.plan=documentResourcePlan(sample);
      if(!this.plan.waiting)break;
      process.stderr.write(`${JSON.stringify({event:'tick',phase:'import.process',stage:'等待电脑释放资源，已完成的部分保留'})}\n`);
      await wait(1000,undefined,{signal:this.signal});
    }
    await wait(this.plan.delayMs,undefined,{signal:this.signal});
  }
  assertText(bytes:number){if(bytes>this.plan.maxTextBytes)throw new Error(`资源保护：解析正文超过本机处理额度（${bytes} bytes，上限 ${this.plan.maxTextBytes} bytes），原文件未修改`);}
}
