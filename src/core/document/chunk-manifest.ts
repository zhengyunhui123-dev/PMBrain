import {createHash} from 'node:crypto';
import type {BrainEngine} from '../engine.ts';

export function documentChunkManifest(chunks:Array<{chunk_index:number;chunk_text:string;chunk_source:string}>){
  const entries=chunks.map(chunk=>`${chunk.chunk_index}:${createHash('md5').update(chunk.chunk_text).digest('hex')}:${chunk.chunk_source}`);
  return {count:chunks.length,hash:createHash('md5').update(entries.join(',')).digest('hex')};
}

export async function readDocumentChunkManifest(engine:Pick<BrainEngine,'executeRaw'>,pageId:number){
  const [state]=await engine.executeRaw<{chunks:number;pending:number;chunk_hash:string}>(`SELECT count(*)::int AS chunks,
    count(*) FILTER (WHERE embedding IS NULL)::int AS pending,
    md5(COALESCE(string_agg(chunk_index::text||':'||md5(chunk_text)||':'||chunk_source,',' ORDER BY chunk_index),'')) AS chunk_hash
    FROM content_chunks WHERE page_id=$1`,[pageId]);
  return state;
}
