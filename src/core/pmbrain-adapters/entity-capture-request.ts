import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
export const ENTITY_CAPTURE_PENDING_PREFIX = 'dream.entity_capture.pending.';
export const ENTITY_CAPTURE_MIN_BODY_CHARS = 8;
export async function requestImportedEntityCapture(engine: BrainEngine, sourceId: string, page: {slug:string;type:string;compiled_truth:string;frontmatter:Record<string,unknown>}): Promise<void> {
  if (['person','company','organization','entity','concept','project'].includes(page.type) || /^(?:people|companies|concepts|projects|wiki\/agents)\//.test(page.slug) || page.frontmatter.dream_generated===true || page.compiled_truth.trim().length<ENTITY_CAPTURE_MIN_BODY_CHARS) return;
  const key=ENTITY_CAPTURE_PENDING_PREFIX+sourceId;
  await engine.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))',[`entity-capture:${sourceId}`]);
  const previous=await engine.getConfig(key);
  let slugs:string[]=[];
  try{const parsed=JSON.parse(previous??'null');if(Array.isArray(parsed?.slugs))slugs=parsed.slugs.filter((x:unknown):x is string=>typeof x==='string');}catch{}
  await engine.setConfig(key,JSON.stringify({nonce:randomUUID(),slugs:[...new Set([...slugs,page.slug])]}));
}
