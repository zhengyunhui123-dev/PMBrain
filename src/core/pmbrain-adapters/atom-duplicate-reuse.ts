import type {BrainEngine,LinkBatchInput} from '../engine.ts';
import {atomTextHash16,type AtomWatermark} from '../cycle/extract-atoms-window.ts';
import {createHash} from 'node:crypto';

interface AtomSource {
  slug:string;
  content:string;
  contentHash:string;
  prior?:AtomWatermark|null;
  identity?:{pageId:number;revision:string;sourceIncarnation:string};
}

interface SourceRow {
  id:number;
  slug:string;
  content_hash:string;
  knowledge_revision:string;
  incarnation:string;
  frontmatter:Record<string,unknown>;
  has_atoms:boolean;
}

function sourceState(row:SourceRow,content:string,cap:number,prior?:AtomWatermark|null):{complete:boolean;readChars:number;prefixHash:string}|null{
  const fm=row.frontmatter??{},hash=row.content_hash.slice(0,16);
  if(fm.atoms_scan_hash===hash||row.has_atoms)return {complete:true,readChars:content.length,prefixHash:atomTextHash16(content)};
  const readChars=Number(fm.atoms_read_chars),partialCap=Number(fm.atoms_partial_cap),prefixHash=String(fm.atoms_read_prefix_hash??'');
  if(fm.atoms_window_hash!==hash||!Number.isSafeInteger(readChars)||readChars<0||readChars>content.length||partialCap<cap||readChars<(prior?.readChars??0))return null;
  if(prefixHash!==atomTextHash16(content.slice(0,readChars)))return null;
  return {complete:false,readChars,prefixHash};
}

export async function reuseAtomSource(engine:BrainEngine,sourceId:string,item:AtomSource,cap:number):Promise<boolean>{
  if(!item.identity)return false;
  const bodyHash=createHash('sha256').update(item.content).digest('hex');
  return engine.transaction(async tx=>{
    const [current]=await tx.executeRaw<{id:number;knowledge_revision:string;incarnation:string;content_hash:string;compiled_truth:string}>(
      `SELECT p.id,p.knowledge_revision,s.incarnation,p.content_hash,p.compiled_truth
         FROM pages p JOIN sources s ON s.id=p.source_id
        WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL AND s.archived=false FOR UPDATE OF p`,[sourceId,item.slug]);
    if(!current||current.id!==item.identity!.pageId||current.knowledge_revision!==item.identity!.revision||current.incarnation!==item.identity!.sourceIncarnation||current.content_hash!==item.contentHash||current.compiled_truth!==item.content)throw new Error('atom_revision_conflict: source changed before duplicate reuse');
    const findOrigins=async(hasFingerprint:boolean)=>tx.executeRaw<SourceRow>(
      `SELECT p.id,p.slug,p.content_hash,p.knowledge_revision,s.incarnation,p.frontmatter,
              EXISTS (SELECT 1 FROM pages atom WHERE atom.source_id=p.source_id AND atom.type='atom' AND atom.deleted_at IS NULL
                AND atom.frontmatter->>'source_slug'=p.slug AND atom.frontmatter->>'source_hash'=substring(p.content_hash from 1 for 16)) AS has_atoms
         FROM pages p JOIN sources s ON s.id=p.source_id
        WHERE p.source_id=$1 AND p.compiled_truth=$2 AND p.content_hash IS NOT NULL AND p.deleted_at IS NULL AND s.archived=false
          AND ${hasFingerprint?"p.frontmatter @> $3::jsonb":"NOT (p.frontmatter ? 'atoms_body_hash')"}
          AND COALESCE(p.frontmatter->>'visibility','world')<>'private' AND COALESCE(p.frontmatter->>'private','false')<>'true'
          AND (p.frontmatter->>'atoms_scan_hash'=substring(p.content_hash from 1 for 16)
            OR p.frontmatter->>'atoms_window_hash'=substring(p.content_hash from 1 for 16)
            OR EXISTS (SELECT 1 FROM pages atom WHERE atom.source_id=p.source_id AND atom.type='atom' AND atom.deleted_at IS NULL
              AND atom.frontmatter->>'source_slug'=p.slug AND atom.frontmatter->>'source_hash'=substring(p.content_hash from 1 for 16)))
        ORDER BY (p.frontmatter->>'atoms_scan_hash'=substring(p.content_hash from 1 for 16)) DESC,p.updated_at DESC
        LIMIT 32 FOR SHARE OF p`,hasFingerprint?[sourceId,item.content,{atoms_body_hash:bodyHash}]:[sourceId,item.content]);
    let origins=await findOrigins(true);
    let origin=origins.map(row=>({row,state:sourceState(row,item.content,cap,item.prior)})).find(value=>value.state);
    if(!origin){origins=await findOrigins(false);origin=origins.map(row=>({row,state:sourceState(row,item.content,cap,item.prior)})).find(value=>value.state);}
    if(!origin?.state)return false;
    const {row,state}=origin;
    if(row.frontmatter.atoms_body_hash!==bodyHash)await tx.executeRaw(
      `UPDATE pages SET frontmatter=frontmatter || jsonb_build_object('atoms_body_hash',$1::text)
        WHERE id=$2 AND source_id=$3 AND content_hash=$4 AND deleted_at IS NULL`,[bodyHash,row.id,sourceId,row.content_hash]);
    if(row.slug!==item.slug){
      const atoms=await tx.executeRaw<{slug:string}>(
        `SELECT atom.slug FROM pages atom WHERE atom.source_id=$1 AND atom.type='atom' AND atom.deleted_at IS NULL
          AND atom.frontmatter->>'source_slug'=$2 AND left(atom.frontmatter->>'source_hash',16)=$3
         UNION
         SELECT atom.slug FROM links l JOIN pages atom ON atom.id=l.from_page_id
          WHERE atom.source_id=$1 AND atom.type='atom' AND atom.deleted_at IS NULL AND l.to_page_id=$4
            AND l.link_type='derives_from' AND l.link_source='concept-provenance' AND l.origin_field='duplicate_source'
            AND l.origin_page_id=$4 AND l.context=$5`,[sourceId,row.slug,row.content_hash.slice(0,16),row.id,row.content_hash]);
      const links:LinkBatchInput[]=atoms.flatMap(atom=>[
        {from_slug:atom.slug,to_slug:item.slug,link_type:'derives_from',link_source:'concept-provenance',context:item.contentHash,origin_slug:item.slug,origin_field:'duplicate_source',from_source_id:sourceId,to_source_id:sourceId,origin_source_id:sourceId},
        {from_slug:item.slug,to_slug:atom.slug,link_type:'evidence_of',link_source:'concept-provenance',context:item.contentHash,origin_slug:item.slug,origin_field:'duplicate_source',from_source_id:sourceId,to_source_id:sourceId,origin_source_id:sourceId},
      ]);
      await tx.addLinksBatch(links,{auditSite:'extract.links_db'});
      if(atoms.length)await tx.executeRaw(
        `UPDATE links SET context=$1 WHERE link_source='concept-provenance' AND origin_field='duplicate_source' AND origin_page_id=$2
          AND ((from_page_id=$2 AND to_page_id IN (SELECT id FROM pages WHERE source_id=$3 AND slug=ANY($4::text[])))
            OR (to_page_id=$2 AND from_page_id IN (SELECT id FROM pages WHERE source_id=$3 AND slug=ANY($4::text[]))))`,
        [item.contentHash,item.identity!.pageId,sourceId,atoms.map(atom=>atom.slug)]);
    }
    const marker=state.complete
      ? {atoms_scan_hash:item.contentHash.slice(0,16),atoms_body_hash:bodyHash}
      : {atoms_read_chars:state.readChars,atoms_read_prefix_hash:state.prefixHash,atoms_window_hash:item.contentHash.slice(0,16),atoms_partial_cap:cap,atoms_body_hash:bodyHash};
    const updated=await tx.executeRaw(
      `UPDATE pages SET frontmatter=(frontmatter-'atoms_fail_hash'-'atoms_fail_signature'-'atoms_fail_count') || $1::jsonb
        WHERE id=$2 AND source_id=$3 AND slug=$4 AND content_hash=$5 AND deleted_at IS NULL RETURNING id`,
      [marker,item.identity!.pageId,sourceId,item.slug,item.contentHash]);
    if(!updated.length)throw new Error('atom_revision_conflict: source changed during duplicate reuse');
    return true;
  });
}
