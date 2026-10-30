import {createHash} from 'node:crypto';
import {mkdir,stat,unlink,lstat} from 'node:fs/promises';
import {dirname,extname,resolve,sep} from 'node:path';
import type {BrainEngine} from '../engine.ts';
import type {ImportResult} from '../import-file.ts';
import {MinionQueue} from '../minions/queue.ts';
import {gbrainPath} from '../config.ts';
import {documentFileHash,snapshotDocument} from '../document/file-snapshot.ts';
import {DocumentRuntime} from '../document/resource-policy.ts';

export const DOCUMENT_OCR_TASK='pmbrain-document-ocr';
export const DOCUMENT_OCR_QUEUE='pmbrain-sync-files';
export interface DeferredDocumentOcr {hash:string;slug:string;relativePath:string;sourceIncarnation:string;sourceRoot:string|null;ownedSnapshot:boolean;image?:boolean;maintenanceOwnerId?:number}
export class DocumentOcrDeferred extends Error {}

export async function queueDocumentOcr(engine:BrainEngine,filePath:string,relativePath:string,hash:string,result:ImportResult,options:{sourceId?:string;ocrOriginalPath?:string|null;deferredOcrVectors?:boolean;deferredOcrMaintenanceOwnerId?:number;runtime:DocumentRuntime;image?:boolean}){
  const sourceId=options.sourceId??'default',runtime=options.runtime;
  const [page]=await engine.executeRaw<{id:number;frontmatter:Record<string,any>;incarnation:string;local_path:string|null}>(`SELECT p.id,p.frontmatter,s.incarnation::text incarnation,s.local_path FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1 AND p.source_id=$2 AND p.deleted_at IS NULL AND NOT s.archived`,[result.slug,sourceId]);
  const pending=Number(page?.frontmatter.document_ocr_failed??0)+Number(page?.frontmatter.document_ocr_skipped??0);
  if(!page||!pending)return result;
  if(page.frontmatter.raw_sha256!==hash)throw Error('资料版本在后台识图入队前已改变，已有内容保留');
  const key='document-ocr:'+createHash('sha256').update(JSON.stringify([sourceId,page.incarnation,page.local_path,page.id,hash])).digest('hex');
  return engine.transaction(async tx=>{
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
    const [existing]=await tx.executeRaw<{id:number}>('SELECT id FROM minion_jobs WHERE idempotency_key=$1',[key]);
    if(existing)return {...result,ocrPending:pending,ocrTaskId:existing.id,embeddingPending:false};
    const maintenanceOwnerId=options.deferredOcrMaintenanceOwnerId;
    if(maintenanceOwnerId){
      const owner=await tx.executeRaw("SELECT id FROM minion_jobs WHERE id=$1 AND data->'task'->>'type'='dream' AND status IN ('active','waiting','waiting-children','delayed') AND (data->'task'->'input'->>'allSources'='true' OR COALESCE(data->'task'->'input'->>'sourceId',$3)=$2)",[maintenanceOwnerId,sourceId,await tx.getConfig('sources.default')??'default']);
      if(!owner.length)throw Error('原整理任务已停止，未提交后台识图');
    }
    const ownedSnapshot=options.ocrOriginalPath===null;
    const path=ownedSnapshot?gbrainPath('task-artifacts','document-ocr',key.slice(13)+extname(relativePath).toLowerCase()):options.ocrOriginalPath??filePath;
    if(ownedSnapshot){
      await mkdir(dirname(path),{recursive:true});
      if(!await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;})){
        const {TaskResourceGuard}=await import('../../product/tasks/resource-guard.ts');const guard=new TaskResourceGuard();
        await guard.assertImportDisk((await stat(filePath)).size);const release=await guard.reserveSnapshot((await stat(filePath)).size);
        try{await snapshotDocument(filePath,path,runtime);}catch(error){release();await unlink(path).catch(failure=>{if(failure.code!=='ENOENT')throw failure;});throw error;}
      }
    }
    if((await lstat(path)).isSymbolicLink()||await documentFileHash(path,runtime)!==hash)throw Error('后台识图资料已改变，已有内容保留');
    const job=await new MinionQueue(tx).add(DOCUMENT_OCR_TASK,{kind:'document_ocr',trigger:'scheduled',task:{type:'import',input:{path,sourceId,noEmbed:maintenanceOwnerId?true:options.deferredOcrVectors!==true,ocrOnly:{hash,slug:result.slug,relativePath,sourceIncarnation:page.incarnation,sourceRoot:page.local_path,ownedSnapshot,image:options.image,maintenanceOwnerId}}}},{queue:DOCUMENT_OCR_QUEUE,idempotency_key:key,max_attempts:1,maxQueueSize:10000,timeout_ms:6*60*60_000,priority:10});
    if(options.image&&ownedSnapshot)await tx.executeRaw('UPDATE files SET storage_path=$2 WHERE page_id=$1 AND content_hash=$3',[page.id,path,hash]);
    const updated=await tx.executeRaw("UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('document_ocr_deferred',true,'document_ocr_task_id',$3::int) WHERE id=$1 AND frontmatter->>'raw_sha256'=$2 RETURNING id",[page.id,hash,job.id]);
    if(!updated.length)throw Error('资料版本在后台识图入队期间已改变，已有内容保留');
    return {...result,ocrPending:pending,ocrTaskId:job.id,embeddingPending:false};
  });
}

export async function validateDeferredDocument(engine:BrainEngine,path:string,sourceId:string,input:DeferredDocumentOcr,runtime:DocumentRuntime,verifyFile=true){
  const [page]=await engine.executeRaw<{hash:string;incarnation:string;local_path:string|null}>(`SELECT p.frontmatter->>'raw_sha256' hash,s.incarnation::text incarnation,s.local_path FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1 AND p.source_id=$2 AND NOT s.archived AND p.deleted_at IS NULL`,[input.slug,sourceId]);
  if(!page||page.hash!==input.hash||page.incarnation!==input.sourceIncarnation||page.local_path!==input.sourceRoot)throw Error('资料或 Source 版本已改变，旧后台识图任务未覆盖内容');
  if(verifyFile&&((await lstat(path)).isSymbolicLink()||await documentFileHash(path,runtime)!==input.hash))throw Error('原始资料已改变，旧后台识图任务未覆盖内容');
}

export async function cleanupDeferredDocument(path:string,input:DeferredDocumentOcr){
  if(!input.ownedSnapshot||input.image)return;
  const root=resolve(gbrainPath('task-artifacts','document-ocr'));
  if(!resolve(path).startsWith(root+sep))throw Error('后台识图快照路径校验失败');
  await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
