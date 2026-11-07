import type { SyncFileActivity, SyncFileDetails } from '../../../shared/task-progress.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import type { SyncFileInput } from './types.ts';
import { appendFile, mkdir, open, stat, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { taskArtifactPath } from './checkpoint.ts';
import { TaskResourceGuard, TASK_LOG_MAX_BYTES } from './resource-guard.ts';
import { randomUUID } from 'node:crypto';

type Row = SyncFileDetails['rows'][number];
type Counts = {total:number;completed:number;failed:number;remaining:number};
type Session = {rows:Map<number,Row>;paths:Map<string,number>;updatedAt:string;activitySavedAt:Map<number,number>;dirtyActivity:Set<number>;counts:Counts};
export class FileProjection {
  private sessions = new Map<number, Session>();
  private tail = Promise.resolve();
  private failure: unknown;
  private pending=new Map<string,{id:number;row:Row}>();
  private writing:number|null=null;
  private draining=false;
  private pinned=new Set<number>();
  private failedSessions=new Set<number>();
  constructor(private options:{maxBytes?:number;resources?:TaskResourceGuard}={}){}
  pin(id:number,value=true){if(value)this.pinned.add(id);else{this.pinned.delete(id);const session=this.sessions.get(id);if(session)this.flushActivity(id,session);}}

  private session(id:number) {
    if(!this.sessions.has(id)&&this.sessions.size>=16){
      const victim=[...this.sessions].find(([key,session])=>key!==this.writing && !this.pinned.has(key) && !session.dirtyActivity.size && ![...this.pending.values()].some(row=>row.id===key));
      if(victim)this.sessions.delete(victim[0]);
      else throw new Error('资源保护：文件明细缓存容量已满，请等待已有任务完成。');
    }
    if (!this.sessions.has(id)) this.sessions.set(id,{rows:new Map(),paths:new Map(),updatedAt:new Date().toISOString(),activitySavedAt:new Map(),dirtyActivity:new Set(),counts:{total:0,completed:0,failed:0,remaining:0}});
    const session=this.sessions.get(id)!;this.sessions.delete(id);this.sessions.set(id,session);return session;
  }

  private apply(id:number,row:Row) {
    if(row.error && row.error.length>2048)row={...row,error:row.error.slice(0,2048)};
    const session=this.session(id);
    const key=JSON.stringify([row.sourceId,row.path]);
    const old=session.paths.get(key);
    if (old!==undefined && old!==row.id) {
      const previous=session.rows.get(old);if(previous)this.countRow(session,previous,-1);
      session.rows.delete(old);session.activitySavedAt.delete(old);session.dirtyActivity.delete(old);
    }
    session.paths.set(key,row.id);
    if(!session.rows.has(row.id)&&session.rows.size>=20000)throw new Error('资源保护：文件明细容量已达到 20000，已停止新增记录。');
    const previous=session.rows.get(row.id);if(previous)this.countRow(session,previous,-1);
    session.rows.set(row.id,row);
    this.countRow(session,row,1);
    session.updatedAt=new Date().toISOString();
  }

  private countRow(session:Session,row:Row,delta:number){
    session.counts.total+=delta;
    if(row.status==='completed')session.counts.completed+=delta;
    else if(row.status==='failed')session.counts.failed+=delta;
    else session.counts.remaining+=delta;
  }

  counts(id:number):Counts|null {
    const session=this.sessions.get(id);
    return session?{...session.counts}:null;
  }

  reconcile(id:number,seen:Set<number>){
    const session=this.sessions.get(id);if(!session)return;
    let changed=false;
    for(const [child,row] of session.rows){
      if(seen.has(child))continue;
      this.countRow(session,row,-1);session.rows.delete(child);session.activitySavedAt.delete(child);session.dirtyActivity.delete(child);
      const key=JSON.stringify([row.sourceId,row.path]);if(session.paths.get(key)===child)session.paths.delete(key);
      changed=true;
    }
    if(changed)session.updatedAt=new Date().toISOString();
  }

  record(job:MinionJob) {
    const id=Number(job.data.sessionId);
    if (!Number.isSafeInteger(id)||id<1||job.data.superseded) return;
    const input=(job.data.task as {input:SyncFileInput}).input;
    const session=this.session(id);
    const previous=session.rows.get(job.id);
    const failed=['failed','partial','error'].includes(String(job.result?.status)) || ['dead','failed'].includes(job.status);
    const row:Row={id:job.id,sourceId:input.options.sourceId??'default',path:input.relativePath,
      status:failed?'failed':job.status==='completed'?'completed':job.status==='active'?'running':'pending',
      error:(job.result?.error as string|undefined)??job.error_text??null,
      activity:previous?.activity};
    if (row.status!=='running') {row.activity=undefined;session.activitySavedAt.delete(job.id);session.dirtyActivity.delete(job.id);}
    if(JSON.stringify(previous)===JSON.stringify(row))return;
    this.apply(id,row); this.save(id,row);
  }

  seed(id:number,rows:Row[],persist=true) {
    const session=this.session(id);
    for(const row of rows){
      const previous=session.rows.get(row.id);
      const next={...row,activity:row.status==='running'?(previous?.activity??row.activity):undefined};
      if(next.status!=='running'){session.activitySavedAt.delete(row.id);session.dirtyActivity.delete(row.id);}
      this.apply(id,next);
      if(persist&&JSON.stringify(previous)!==JSON.stringify(next))this.save(id,next);
    }
  }
  activity(id:number,child:number,activity:SyncFileActivity,coalesce=false) {
    const session=this.session(id);
    const row=session.rows.get(child);
    if (!row||(coalesce&&row.status!=='running')) return;
    const next={...row,activity};this.apply(id,next);
    if(!coalesce){this.save(id,next);return;}
    const now=Date.now(),last=session.activitySavedAt.get(child);
    if(row.activity?.stage!==activity.stage||last===undefined||now-last>=1000){
      session.activitySavedAt.set(child,now);session.dirtyActivity.delete(child);this.save(id,next);
    }else session.dirtyActivity.add(child);
  }

  private flushActivity(id:number,session:Session){
    for(const child of session.dirtyActivity){
      const row=session.rows.get(child);
      if(row?.status==='running'&&row.activity){session.activitySavedAt.set(child,Date.now());this.save(id,row);}
    }
    session.dirtyActivity.clear();
  }

  private save(id:number,row:Row) {
    const key=JSON.stringify([id,row.sourceId,row.path]);
    if(!this.pending.has(key)&&this.pending.size>=20000)throw new Error('资源保护：文件明细待写容量已满。');
    this.pending.set(key,{id,row:{...row,error:row.error?.slice(0,2048)??null}});
    if(this.draining)return;
    this.draining=true;
    this.tail=(async()=>{
      while(this.pending.size){
        const [key,{id,row}]=this.pending.entries().next().value!;this.writing=id;this.pending.delete(key);
        const path=taskArtifactPath(id,'files.jsonl');await mkdir(dirname(path),{recursive:true});
        const line=JSON.stringify(row)+'\n';
        await (this.options.resources??new TaskResourceGuard()).assertDisk(path,Buffer.byteLength(line));
        const size=await stat(path).then(info=>info.size).catch(error=>{if(error.code==='ENOENT')return 0;throw error;});
        if(size+Buffer.byteLength(line)>(this.options.maxBytes??TASK_LOG_MAX_BYTES))await this.compact(id);
        else await appendFile(path,line,{mode:0o600});
      }
    })().catch(error=>{
      this.failure=error;
      for(const id of [this.writing,...[...this.pending.values()].map(row=>row.id)])if(id!==null){this.failedSessions.add(id);this.pin(id);}
      this.pending.clear();
    }).finally(()=>{this.draining=false;this.writing=null;});
  }

  private async compact(id:number){
    const path=taskArtifactPath(id,'files.jsonl');const temporary=path+'.part-'+randomUUID();
    const file=await open(temporary,'wx',0o600);let bytes=0;
    try{
      for(const row of this.session(id).rows.values()){
        const line=JSON.stringify(row)+'\n';bytes+=Buffer.byteLength(line);
        if(bytes>(this.options.maxBytes??TASK_LOG_MAX_BYTES))throw new Error('资源保护：文件明细日志容量不足，已停止写入。');
        await file.writeFile(line);
      }
      await file.close();await rename(temporary,path);
    }finally{await file.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }

  async load(id:number) {
    await this.flush();
    const path=taskArtifactPath(id,'files.jsonl');
    const file=await open(path,'r').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    this.session(id);
    if(!file)return;
    const buffer=Buffer.allocUnsafe(64*1024);let carry=Buffer.alloc(0);
    try{
      while(true){
        const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;
        const block=Buffer.concat([carry,buffer.subarray(0,bytesRead)]);let offset=0;
        for(let end=block.indexOf(10);end>=0;end=block.indexOf(10,offset)){
          if(end-offset>64*1024)throw new Error('资源保护：文件明细单行过大。');
          if(end>offset)this.apply(id,JSON.parse(block.subarray(offset,end).toString('utf8')));
          offset=end+1;
        }
        carry=Buffer.from(block.subarray(offset));if(carry.length>64*1024)throw new Error('资源保护：文件明细单行过大。');
      }
      if(carry.length){try{this.apply(id,JSON.parse(carry.toString('utf8')));}catch{}}
    }finally{await file.close();}
    if((await stat(path)).size>(this.options.maxBytes??TASK_LOG_MAX_BYTES)){
      await (this.options.resources??new TaskResourceGuard()).assertDisk(path,this.options.maxBytes??TASK_LOG_MAX_BYTES);
      await this.compact(id);
    }
  }

  details(id:number,after=0):SyncFileDetails|null {
    const session=this.sessions.get(id);if(!session)return null;
    const rows=[...session.rows.values()].filter(row=>row.id>after).sort((a,b)=>a.id-b.id).slice(0,51);
    return {rows:rows.slice(0,50),next:rows.length>50?rows[49].id:null,updatedAt:session.updatedAt};
  }

  active(id:number):SyncFileActivity[] {return [...this.session(id).rows.values()].filter(row=>row.status==='running'&&row.activity).map(row=>row.activity!);}
  async recover(){
    await this.tail;
    if(!this.failure)return;
    for(const id of this.failedSessions){
      await (this.options.resources??new TaskResourceGuard()).assertDisk(taskArtifactPath(id,'files.jsonl'),this.options.maxBytes??TASK_LOG_MAX_BYTES);
      await this.compact(id);this.pin(id,false);
    }
    this.failedSessions.clear();this.failure=undefined;
  }
  async flush(){for(const [id,session] of this.sessions)this.flushActivity(id,session);await this.tail;if(this.failure)throw this.failure;}
}
