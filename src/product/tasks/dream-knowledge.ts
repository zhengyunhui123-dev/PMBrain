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

export async function prepareProductEnrichThin(engine:BrainEngine):Promise<void>{
  await engine.transaction(async tx=>{
    if(await tx.getConfig('cycle.enrich_thin.enabled')===null)await tx.setConfig('cycle.enrich_thin.enabled','true');
    if(await tx.getConfig('cycle.enrich_thin.types')===null)await tx.setConfig('cycle.enrich_thin.types',JSON.stringify(['person','company','project']));
  });
}

export async function resetHeldDreamKnowledge(engine:BrainEngine,sourceId:string):Promise<void>{
  await engine.transaction(async tx=>{
    await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter-'atoms_fail_hash'-'atoms_fail_signature'-'atoms_fail_count'
      WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'atoms_fail_hash'=content_hash
        AND CASE WHEN COALESCE(frontmatter->>'atoms_fail_count','') ~ '^[0-9]+$'
          THEN (frontmatter->>'atoms_fail_count')::numeric >= 3 ELSE false END`,[sourceId]);
    const rows=await tx.executeRaw<{key:string;value:string}>("SELECT key,value FROM config WHERE key LIKE 'dream.concepts.retry.%'");
    for(const row of rows){
      let state:unknown;
      try{state=JSON.parse(row.value);}catch{continue;}
      if(state&&typeof state==='object'&&!Array.isArray(state)&&(state as {sourceId?:string}).sourceId===sourceId&&Number((state as {attempts?:number}).attempts)>=3)await tx.unsetConfig(row.key);
    }
  });
}
