import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureGateway,resetGateway} from '../../src/core/ai/gateway.ts';
import {harvestWritebackBank} from '../../src/core/facts/writeback-harvest.ts';
import {bankWritebackTurn} from '../../src/core/facts/writeback-bank.ts';
import {gateWritebackTurn} from '../../src/core/facts/writeback-gate.ts';

test('收获使用银行 Source 和既有 Pipeline，关闭后不再写入',async()=>{
  const home=mkdtempSync(join(tmpdir(),'pmbrain-harvest-'));
  const old=process.env.PMBRAIN_HOME;process.env.PMBRAIN_HOME=home;
  let mode='salient';let calls=0;
  const engine={getConfig:async(key:string)=>key==='memory.auto_writeback'?mode:null,executeRaw:async(_sql:string,params:unknown[])=>params[0]==='work'?[{id:'work'}]:[]} as any;
  const gated=gateWritebackTurn('以后所有产品评审都先给出可核实的依据。');if(!gated.ok)throw Error('gate');
  configureGateway({chat_model:'ollama:qwen3:4b',env:{}});
  try{
    mkdirSync(join(home,'.pmbrain'));
    writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({memory:{auto_writeback:'salient'}}));
    bankWritebackTurn({dir:home,sessionId:'sess',normalizedTurn:gated.normalized,hash24:gated.hash24,sourceId:'work'});
    const pipeline: any=async(_text:string,ctx:any)=>{calls++;expect(ctx.sourceId).toBe('work');expect(ctx.source).toBe('Claude Stop Hook / ambient writeback');expect(ctx.notabilityFilter).toBe('medium-plus');return {inserted:1,duplicate:0,superseded:0,fact_ids:[1]};};
    await harvestWritebackBank(engine,{dir:home,pipeline});
    await harvestWritebackBank(engine,{dir:home,pipeline});
    expect(calls).toBe(1);expect(readdirSync(home).some(n=>n.endsWith('.done'))).toBe(true);
    mode='off';
    bankWritebackTurn({dir:home,sessionId:'other',normalizedTurn:gated.normalized,hash24:gated.hash24,sourceId:'work'});
    await harvestWritebackBank(engine,{dir:home,pipeline});expect(calls).toBe(1);
  }finally{resetGateway();if(old===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=old;rmSync(home,{recursive:true,force:true});}
});
