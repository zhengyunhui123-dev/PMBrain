import type { BrainEngine } from '../engine.ts';

export async function readPhaseBudget(engine:BrainEngine,key:string,fallback:number):Promise<number>{
  const raw=await engine.getConfig(key);
  if(raw===null||raw===undefined||raw==='')return fallback;
  const value=Number(raw);
  if(!Number.isFinite(value)||value<=0)throw new Error(`invalid_phase_budget: ${key} must be a positive finite number`);
  return value;
}
