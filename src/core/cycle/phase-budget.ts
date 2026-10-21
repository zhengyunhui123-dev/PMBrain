import type { BrainEngine } from '../engine.ts';
import {DEFAULT_USD_TO_CNY} from '../../../shared/model-billing.ts';

export async function readPhaseBudget(engine:BrainEngine,key:string,fallback:number):Promise<number>{
  const cny=key.endsWith('.budget_usd')?await engine.getConfig(key.replace('.budget_usd','.budget_cny')):null;
  if(cny!==null){const rate=Number(await engine.getConfig('pricing.usd_to_cny')??DEFAULT_USD_TO_CNY);const amount=Number(cny);if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(rate)||rate<=0)throw new Error('invalid_phase_budget: invalid CNY price or exchange rate');return amount/rate;}
  const raw=await engine.getConfig(key);
  if(raw===null||raw===undefined||raw==='')return fallback;
  const value=Number(raw);
  if(!Number.isFinite(value)||value<=0)throw new Error(`invalid_phase_budget: ${key} must be a positive finite number`);
  return value;
}
