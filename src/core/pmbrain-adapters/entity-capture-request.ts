import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
export const ENTITY_CAPTURE_PENDING_PREFIX = 'dream.entity_capture.pending.';
export const ENTITY_CAPTURE_MIN_BODY_CHARS = 8;
export const EXCLUDED_CAPTURE_PATH=/((^|\/)(\.pmbrain|\.gbrain|\.git|node_modules|backups?)(\/|$))|(^output\/(agent-notes|wiki-compile|wiki-health|qa)(\/|$))|(\.(bak|backup)(\.|$))/i;
export function excludedCapturePath(slug:string):boolean {
  return EXCLUDED_CAPTURE_PATH.test(slug.replace(/\\/g,'/'));
}
export async function requestImportedEntityCapture(engine: BrainEngine, sourceId: string, page: {slug:string;type:string;compiled_truth:string;frontmatter:Record<string,unknown>}): Promise<void> {
  if (excludedCapturePath(page.slug) || ['person','company','organization','entity','concept','project'].includes(page.type) || /^(?:people|companies|concepts|projects|wiki\/agents)\//.test(page.slug) || page.frontmatter.dream_generated===true || page.frontmatter.pmbrain_ingest_provenance || page.compiled_truth.trim().length<ENTITY_CAPTURE_MIN_BODY_CHARS) return;
  const key=ENTITY_CAPTURE_PENDING_PREFIX+sourceId;
  await engine.transaction(async tx=>{
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))',[`entity-capture:${sourceId}`]);
    const previous=await tx.getConfig(key);
    let slugs:string[]=[],previousOwner:number|undefined,owners:Record<string,number>={};
    try{const parsed=JSON.parse(previous??'null');if(Array.isArray(parsed?.slugs))slugs=parsed.slugs.filter((x:unknown):x is string=>typeof x==='string');if(Number.isSafeInteger(parsed?.ownerJobId))previousOwner=parsed.ownerJobId;if(parsed?.owners&&typeof parsed.owners==='object')owners=parsed.owners;}catch{}
    const [owner]=await tx.executeRaw<{id:number}>(`SELECT id FROM minion_jobs WHERE queue='pmbrain-product'
      AND (data->'task'->>'type'='import' OR data->'task'->'input'->>'preset' IN ('quick','full') OR (data->>'fileSession'='true' AND data->'task'->'input'->>'phase' IS DISTINCT FROM 'sync'))
      AND data->'task'->'input'->>'dryRun' IS DISTINCT FROM 'true'
      AND (data->'task'->'input'->>'allSources'='true' OR COALESCE(data->'task'->'input'->>'sourceId','default')=$1)
      AND status IN ('waiting','active','waiting-children','delayed') ORDER BY id LIMIT 1`,[sourceId]);
    if(owner)owners[page.slug]=owner.id;
    await tx.setConfig(key,JSON.stringify({nonce:randomUUID(),incremental:true,slugs:[...new Set([...slugs,page.slug])],owners,ownerJobId:owner?.id??previousOwner}));
  });
}
