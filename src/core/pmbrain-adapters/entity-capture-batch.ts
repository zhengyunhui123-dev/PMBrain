import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { BrainEngine } from '../engine.ts';
import type { ToolDef } from '../minions/types.ts';
import { UnrecoverableError } from '../minions/types.ts';
import { rewriteCapturedIdentity } from '../cycle/entity-capture-budget.ts';
import type { EntityIngestContext } from './entity-ingest-workflow.ts';
import type { CaptureReceipt } from './entity-capture-receipts.ts';
import { withCaptureWrite } from './entity-capture-window.ts';
import { sourceTimelineDates } from './entity-capture-plan.ts';
import { assertCaptureLease, decideCapturedIdentity, ingestCandidatesChanged, isolateIngestItem, loadIngestCandidates, type IdentityCandidate } from './entity-identity-decision.ts';

type Step = { output: Record<string, unknown>; proof: NonNullable<CaptureReceipt['capture_proof']> };
type Held = { slug: string; reason: string; candidates?: IdentityCandidate[] };
type Relation = { from: string; to: string; link_type: string; evidence: string };
type State = { version: 1; payload_hash: string; completed: Record<string, Step>; pending: Record<string, Held>; failed: Record<string, Held> };
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,stable(child)])) : value;
const heldReason = (error: UnrecoverableError) => /verify existing entity/.test(error.message)
  ? '名称与已有实体相近，需要确认是同一对象还是有证据的新对象'
  : /ambiguous existing entity|reuse existing entity|pending entity merge/.test(error.message)
    ? '已有实体身份需要确认，未自动合并'
    : error.message;

export function captureBatchTool(put: ToolDef, context: EntityIngestContext, checks: {
  required: (engine: BrainEngine, jobId: number) => Promise<string[]>;
  validate: (engine: BrainEngine, text: string, required: string[]) => Promise<void>;
}, timeline?:ToolDef): ToolDef {
  const maxEntities=context.single_pass?128:32;
  return {
    name: 'brain_capture_entities',
    description: `一次提交本段值得记录实体的事实增量及证据关系，每次最多${maxEntities}个实体。entities 每项提供准确 slug 和含 YAML title/type、逐条 Source 引用的 Markdown content；程序保留旧事实并逐项原子保存。名称相近时返回待确认身份，不自动合并。reused_entities 列出只复用而无新增事实的实体。尚有其他实体时设置 has_more:true；程序验证关系并记录完成情况。`,
    input_schema: { type:'object',additionalProperties:false,properties:{
      entities:{type:'array',maxItems:maxEntities,items:{type:'object',additionalProperties:false,properties:{
        slug:{type:'string'},content:{type:'string',maxLength:65536},
        identity_confirmed:{type:'boolean'},distinguishing_evidence:{type:'string',maxLength:500},
      },required:['slug','content']}},
      reused_entities:{type:'array',maxItems:context.single_pass?128:64,items:{type:'string'}},
      relations:{type:'array',maxItems:128,items:{type:'object',properties:{from:{type:'string'},to:{type:'string'},link_type:{type:'string'},evidence:{type:'string'}},required:['from','to','link_type','evidence']}},
      ...(context.single_pass?{timeline_entries:{type:'array',maxItems:128,items:{type:'object',properties:{slug:{type:'string'},date:{type:'string'},summary:{type:'string'},detail:{type:'string'}},required:['slug','date','summary']}}}:{}),
      no_entities:{type:'boolean'},
      has_more:{type:'boolean'},
    },required:['entities','relations']},
    idempotent:true,
    async execute(raw,ctx){
      ctx.signal?.throwIfAborted();
      if(!ctx.toolUseId)throw new UnrecoverableError('ingest batch requires a durable tool execution identity');
      const input=raw as {entities?:Array<{slug:string;content:string;identity_confirmed?:boolean;distinguishing_evidence?:string}>;reused_entities?:string[];relations?:Relation[];no_entities?:boolean;has_more?:boolean;timeline_entries?:Array<{slug:string;date:string;summary:string;detail?:string;source?:string}>};
      if(!input||!Array.isArray(input.entities)||input.entities.length>maxEntities||!Array.isArray(input.relations)||input.relations.length>128
        ||input.entities.some(entity=>!entity||typeof entity.slug!=='string'||typeof entity.content!=='string'||entity.content.length>65536
          ||entity.identity_confirmed!==undefined&&typeof entity.identity_confirmed!=='boolean'
          ||entity.distinguishing_evidence!==undefined&&typeof entity.distinguishing_evidence!=='string')
        ||Buffer.byteLength(JSON.stringify(input),'utf8')>1024*1024)throw new UnrecoverableError('ingest batch input exceeds its bounded schema');
      if(context.single_pass&&Object.keys(input).some(key=>!['entities','reused_entities','relations','timeline_entries','no_entities','has_more'].includes(key)))throw new UnrecoverableError('ingest batch unknown fields');
      const identity=(reference:string)=>reference.includes(':')?reference:`${context.sourceId}:${reference}`;
      if(new Set(input.entities.map(entity=>identity(entity.slug))).size!==input.entities.length)throw new UnrecoverableError('ingest batch requires one fact delta per entity');
      if(input.reused_entities!==undefined&&(!Array.isArray(input.reused_entities)||input.reused_entities.length>(context.single_pass?128:64)||input.reused_entities.some(reference=>typeof reference!=='string')))throw new UnrecoverableError('ingest batch reused identities are invalid');
      if(input.has_more!==undefined&&typeof input.has_more!=='boolean'||input.no_entities!==undefined&&typeof input.no_entities!=='boolean'||input.has_more&&input.no_entities)throw new UnrecoverableError('ingest batch completion flag is invalid');
      if(input.no_entities&&(input.entities.length||input.reused_entities?.length||input.relations.length||input.timeline_entries?.length))throw new UnrecoverableError('ingest no_entities conflicts with proposed entities');
      if(input.timeline_entries!==undefined&&(!context.single_pass||!Array.isArray(input.timeline_entries)||input.timeline_entries.length>128||input.timeline_entries.some(entry=>!entry||typeof entry.slug!=='string'||typeof entry.date!=='string'||typeof entry.summary!=='string'||entry.detail!==undefined&&typeof entry.detail!=='string')))throw new UnrecoverableError('ingest timeline entries are invalid');
      if(input.timeline_entries?.length&&!timeline)throw new UnrecoverableError('ingest timeline has no exact date in the source');
      if(input.timeline_entries?.some(entry=>!sourceTimelineDates(context.chunkBody).includes(entry.date)||!entry.summary.trim()))throw new UnrecoverableError('ingest timeline date or summary has no exact source evidence');
      const hash=createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
      const [row]=await ctx.engine.executeRaw<{output:unknown}>(`SELECT output FROM subagent_tool_executions
        WHERE job_id=$1 AND gbrain_tool_use_id::text=$2 AND status='pending'`,[ctx.jobId,ctx.toolUseId]);
      if(!row)throw new UnrecoverableError('ingest batch execution is no longer pending');
      const previous=(typeof row.output==='string'?JSON.parse(row.output):row.output) as Partial<State>|null;
      if(previous&&(previous.version!==1||previous.payload_hash!==hash))throw new UnrecoverableError('ingest batch replay input changed');
      const state:State={version:1,payload_hash:hash,completed:previous?.completed??{},pending:previous?.pending??{},failed:previous?.failed??{}};
      const {captureReceiptProof,reuseCaptureReceipt}=await import('./entity-capture-receipts.ts');
      const sourceIds=[context.sourceId,'default'];
      let candidates=await loadIngestCandidates(ctx.engine,sourceIds);
      const persist=async(tx:BrainEngine,completedPatch:Record<string,Step>)=>{
        await assertCaptureLease(tx,ctx.jobId,ctx.executionToken,ctx.signal);
        const updated=await tx.executeRaw(`UPDATE subagent_tool_executions SET output=jsonb_build_object('version',1,'payload_hash',$3::text,
          'completed',COALESCE(output->'completed','{}'::jsonb)||$4::text::jsonb,'pending',$5::text::jsonb,'failed',$6::text::jsonb)
          WHERE job_id=$1 AND gbrain_tool_use_id::text=$2 AND status='pending' AND (output IS NULL OR output->>'payload_hash'=$3) RETURNING id`,
          [ctx.jobId,ctx.toolUseId,hash,JSON.stringify(completedPatch),JSON.stringify(state.pending),JSON.stringify(state.failed)]);
        if(updated.length!==1)throw new UnrecoverableError('ingest batch commit receipt lost its execution identity');
      };
      try{
      context.candidatePages=candidates;
      for(const [index,entity] of input.entities.entries()){
        ctx.signal?.throwIfAborted();
        const key=String(index);
        if(state.pending[key]||state.failed[key])continue;
        const stored=state.completed[key];
        if(stored){
          const reference=String(stored.output.slug),colon=reference.indexOf(':');
          const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
          const reused=await withCaptureWrite(ctx.engine,ctx.signal,()=>reuseCaptureReceipt(ctx.engine,context,{capture_proof:stored.proof,ingest_entities:[{sourceId,slug}]}));
          if(!reused)throw new UnrecoverableError('ingest revision conflict; an already committed batch entity changed');
          continue;
        }
        const record=async(tx:BrainEngine,value:unknown)=>{
          const output=value as Record<string,unknown>;
          if(output.status==='merge_required')throw new UnrecoverableError('ingest pending entity merge');
          const reference=String(output.slug??entity.slug),colon=reference.indexOf(':');
          const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
          const step:Step={output:{...output,slug:`${sourceId}:${slug}`},proof:await captureReceiptProof(tx,context,[{sourceId,slug}])};
          await persist(tx,{[key]:step});
          state.completed[key]=step;
        };
        try{
          await assertCaptureLease(ctx.engine,ctx.jobId,ctx.executionToken,ctx.signal);
          if(await ingestCandidatesChanged(ctx.engine,candidates,sourceIds)){
            candidates=await loadIngestCandidates(ctx.engine,sourceIds);
            context.candidatePages=candidates;
          }
          const colon=entity.slug.indexOf(':');
          const sourceId=colon<0?context.sourceId:entity.slug.slice(0,colon);
          const slug=colon<0?entity.slug:entity.slug.slice(colon+1);
          const parsed=matter(entity.content);
          const title=String(parsed.data?.title??'');
          const type=String(parsed.data?.type??'');
          const decision=decideCapturedIdentity({
            title,type,slug,sourceId,pageExists:!!(await ctx.engine.getPage(slug,{sourceId})),pages:candidates,chunkBody:context.chunkBody,
            confirmedNew:entity.identity_confirmed===true,distinguishingEvidence:entity.distinguishing_evidence,
          });
          if(decision.decision==='pending'){
            state.pending[key]={slug:identity(entity.slug),reason:decision.reason,candidates:decision.candidates};
            await ctx.engine.transaction(tx=>persist(tx,{}));
            continue;
          }
          const write=decision.decision==='reuse'
            ?{slug:`${decision.source_id}:${decision.slug}`,content:rewriteCapturedIdentity(entity.content,decision.title,title)}
            :entity;
          if(decision.decision==='create'&&entity.identity_confirmed===true&&entity.distinguishing_evidence?.trim())context.confirmedVariant={slug,evidence:entity.distinguishing_evidence.trim()};
          const output=await put.execute(write,{...ctx,persistCommit:record});
          if(!state.completed[key])await ctx.engine.transaction(tx=>record(tx,output));
        }catch(error){
          if(state.completed[key])throw error;
          const kind=isolateIngestItem(error);
          if(kind==='stop')throw error;
          const bucket=kind==='pending'?state.pending:state.failed;
          bucket[key]={slug:identity(entity.slug),reason:error instanceof UnrecoverableError?heldReason(error):'实体保存失败'};
          await ctx.engine.transaction(tx=>persist(tx,{}));
        }finally{delete context.confirmedVariant;}
      }
      for(const [index,entry] of (input.timeline_entries??[]).entries()){
        ctx.signal?.throwIfAborted();
        const key=`timeline:${index}`;
        const stored=state.completed[key];
        if(stored){
          const reference=String(stored.output.slug),colon=reference.indexOf(':');
          const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
          const reused=await withCaptureWrite(ctx.engine,ctx.signal,()=>reuseCaptureReceipt(ctx.engine,context,{capture_proof:stored.proof,ingest_entities:[{sourceId,slug}]}));
          if(!reused)throw new UnrecoverableError('ingest revision conflict; an already committed timeline entity changed');
          continue;
        }
        const record=async(tx:BrainEngine,value:unknown)=>{
          const output=value as Record<string,unknown>,reference=String(output.slug??entry.slug),colon=reference.indexOf(':');
          const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
          const step:Step={output:{...output,slug:`${sourceId}:${slug}`},proof:await captureReceiptProof(tx,context,[{sourceId,slug}])};
          await persist(tx,{[key]:step});
          state.completed[key]=step;
        };
        const output=await timeline!.execute({...entry,source:context.slug},{...ctx,persistCommit:record});
        if(!state.completed[key])await ctx.engine.transaction(tx=>record(tx,output));
      }
      const blocked=new Set<string>();
      for(const item of [...Object.values(state.pending),...Object.values(state.failed)]){
        blocked.add(item.slug);
        const bare=item.slug.includes(':')?item.slug.slice(item.slug.indexOf(':')+1):item.slug;
        blocked.add(bare);blocked.add(identity(bare));
      }
      const touches=(reference:string)=>blocked.has(reference)||blocked.has(identity(reference))||blocked.has(reference.includes(':')?reference.slice(reference.indexOf(':')+1):reference);
      const deferred=input.relations.filter(relation=>!!relation&&(touches(String(relation.from))||touches(String(relation.to))));
      const kept=input.relations.filter(relation=>!!relation&&!touches(String(relation.from))&&!touches(String(relation.to)));
      const required=await checks.required(ctx.engine,ctx.jobId);
      const entities=[...new Set([...required,...Object.values(state.completed).map(step=>String(step.output.slug)),...(input.reused_entities??[]).filter(reference=>!touches(reference))])];
      if(input.no_entities&&entities.length)throw new UnrecoverableError('ingest no_entities conflicts with committed entities');
      const prior=await ctx.engine.executeRaw<{output:unknown}>("SELECT output FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_capture_entities' AND status='complete' AND output IS NOT NULL",[ctx.jobId]);
      const relations=[...new Map([...prior.flatMap(row=>{const output=typeof row.output==='string'?JSON.parse(row.output):row.output as {receipt?:string};return output?.receipt?JSON.parse(output.receipt).relations??[]:[];}),...kept].map(relation=>[JSON.stringify(stable(relation)),relation])).values()];
      const pendingReview=Object.values(state.pending),failedItems=Object.values(state.failed);
      const receipt=JSON.stringify({entities,relations,...(input.no_entities?{no_entities:true}:{}),...(entities.length===0&&pendingReview.length+failedItems.length>0?{capture_incomplete:true}:{})});
      await checks.validate(ctx.engine,receipt,required);
      const review=pendingReview.length?'部分实体身份待确认。请只重新提交这些实体：复用候选里的 source_id 和 slug，或设置 identity_confirmed 为 true，并把原文中能区分新对象的原句作为 distinguishing_evidence。不要读取页面，不要按名称相近自动合并。':'';
      const continuation=input.has_more||input.entities.length===maxEntities;
      return {...state,status:continuation?'partial':'ready',receipt,pending_review:pendingReview,failed_items:failedItems,deferred_relations:deferred,
        ...(review||continuation?{instruction:[continuation?'本批已保存。继续提交本段剩余实体；全部处理完后使用 complete_ingest 验收完整清单。':'',review].filter(Boolean).join('')}:{})};
      }finally{delete context.candidatePages;delete context.confirmedVariant;}
    },
  };
}
