import { existsSync, readdirSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, loadConfigFileOnly } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { runFactsPipeline } from './backstop.ts';
import { resolveWritebackConfig, HOOK_WRITEBACK_PROVENANCE } from './writeback-config.ts';
import { gateWritebackTurn } from './writeback-gate.ts';
import { parseWritebackSourceId } from './writeback-bank.ts';
import { isAvailable } from '../ai/gateway.ts';

const running=new WeakSet<BrainEngine>();

export async function harvestWritebackBank(engine: BrainEngine, opts: { dir?: string; signal?: AbortSignal; pipeline?: typeof runFactsPipeline } = {}) {
  if(running.has(engine))return;
  running.add(engine);
  try {
    const wb=await resolveWritebackConfig(engine,loadConfigFileOnly(),{gate:true});
    if(!wb.enabled||!isAvailable('chat'))return;
    const dir=opts.dir??join(configDir(),'writeback-corpus');
    if(!existsSync(dir))return;
    for(const name of readdirSync(dir).filter(n=>/^[a-zA-Z0-9_-]{1,128}\.wb-[a-f0-9]{24}\.src-[a-z0-9-]+\.txt$/.test(n)).slice(0,20)){
      if(opts.signal?.aborted)break;
      const path=join(dir,name);
      const stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8193)continue;
      const sourceId=parseWritebackSourceId(name);
      if(!sourceId)continue;
      const sources=await engine.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived=false',[sourceId]);
      if(!sources.length)continue;
      const text=readFileSync(path,'utf8');
      const gated=gateWritebackTurn(text);
      if(!gated.ok||!name.includes(`.wb-${gated.hash24}.src-`))continue;
      const canWrite=async()=>!opts.signal?.aborted&&(await resolveWritebackConfig(engine,loadConfigFileOnly(),{gate:true})).enabled;
      if(!await canWrite())break;
      const signal=opts.signal?AbortSignal.any([opts.signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000);
      await (opts.pipeline??runFactsPipeline)(gated.normalized,{engine,sourceId,sessionId:name.split('.wb-')[0],source:HOOK_WRITEBACK_PROVENANCE,notabilityFilter:wb.mode==='salient'?'medium-plus':'all',visibility:wb.visibility,abortSignal:signal,canWrite,throwOnExtractionError:true});
      if(await canWrite())renameSync(path,`${path}.done`);
    }
  } finally {running.delete(engine);}
}

export function startWritebackHarvester(engine: BrainEngine) {
  const abort=new AbortController();
  const tick=()=>void harvestWritebackBank(engine,{signal:abort.signal}).catch(e=>console.error(`[memory_writeback] ${e instanceof Error?e.message:String(e)}`));
  const timer=setInterval(tick,15000);timer.unref?.();
  tick();
  return ()=>{clearInterval(timer);abort.abort();};
}
