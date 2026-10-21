import type {BrainEngine} from '../../core/engine';

export async function prepareDreamKnowledge(engine:BrainEngine):Promise<boolean>{
  const stored=await engine.getConfig('dream.knowledge.enabled');
  if(stored!==null)return stored!=='false';
  return engine.transaction(async tx=>{
    const current=await tx.getConfig('dream.knowledge.enabled');
    if(current!==null)return current!=='false';
    await tx.setConfig('dream.knowledge.enabled','true');
    for(const key of ['dream.synthesize.conversation_pages','dream.synthesize.enabled'])if(await tx.getConfig(key)===null)await tx.setConfig(key,'true');
    return true;
  });
}
