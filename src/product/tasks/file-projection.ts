import type { SyncFileActivity, SyncFileDetails } from '../../../shared/task-progress.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import type { SyncFileInput } from './types.ts';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { taskArtifactPath } from './checkpoint.ts';

type Row = SyncFileDetails['rows'][number];
export class FileProjection {
  private sessions = new Map<number, {rows:Map<number,Row>; paths:Map<string,number>; updatedAt:string}>();
  private tail = Promise.resolve();
  private failure: unknown;

  private session(id:number) {
    if (!this.sessions.has(id)) this.sessions.set(id,{rows:new Map(),paths:new Map(),updatedAt:new Date().toISOString()});
    return this.sessions.get(id)!;
  }

  private apply(id:number,row:Row) {
    const session=this.session(id);
    const key=JSON.stringify([row.sourceId,row.path]);
    const old=session.paths.get(key);
    if (old!==undefined && old!==row.id) session.rows.delete(old);
    session.paths.set(key,row.id);
    session.rows.set(row.id,row);
    session.updatedAt=new Date().toISOString();
  }

  record(job:MinionJob) {
    const id=Number(job.data.sessionId);
    if (!Number.isSafeInteger(id)||id<1||job.data.superseded) return;
    const input=(job.data.task as {input:SyncFileInput}).input;
    const previous=this.session(id).rows.get(job.id);
    const failed=['failed','partial','error'].includes(String(job.result?.status)) || ['dead','failed'].includes(job.status);
    const row:Row={id:job.id,sourceId:input.options.sourceId??'default',path:input.relativePath,
      status:failed?'failed':job.status==='completed'?'completed':job.status==='active'?'running':'pending',
      error:(job.result?.error as string|undefined)??job.error_text??null,
      activity:previous?.activity};
    if (row.status!=='running') row.activity=undefined;
    this.apply(id,row); this.save(id,row);
  }

  seed(id:number,rows:Row[]) {
    const session=this.session(id);
    for(const row of rows){
      const previous=session.rows.get(row.id);
      const next={...row,activity:row.status==='running'?(previous?.activity??row.activity):undefined};
      this.apply(id,next);
      if(JSON.stringify(previous)!==JSON.stringify(next))this.save(id,next);
    }
  }
  activity(id:number,child:number,activity:SyncFileActivity) {
    const row=this.session(id).rows.get(child);
    if (!row) return;
    const next={...row,activity}; this.apply(id,next); this.save(id,next);
  }

  private save(id:number,row:Row) {
    this.tail=this.tail.then(async()=>{
      const path=taskArtifactPath(id,'files.jsonl'); await mkdir(dirname(path),{recursive:true});
      await appendFile(path,JSON.stringify(row)+'\n',{mode:0o600});
    }).catch(error=>{this.failure=error;});
  }

  async load(id:number) {
    const text=await readFile(taskArtifactPath(id,'files.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    this.session(id);
    const lines=text.split('\n');
    for(let index=0;index<lines.length;index++){
      if(!lines[index])continue;
      try {this.apply(id,JSON.parse(lines[index]));} catch(error){if(index!==lines.length-1)throw error;}
    }
  }

  details(id:number,after=0):SyncFileDetails|null {
    const session=this.sessions.get(id);if(!session)return null;
    const rows=[...session.rows.values()].filter(row=>row.id>after).sort((a,b)=>a.id-b.id).slice(0,51);
    return {rows:rows.slice(0,50),next:rows.length>50?rows[49].id:null,updatedAt:session.updatedAt};
  }

  active(id:number):SyncFileActivity[] {return [...this.session(id).rows.values()].filter(row=>row.status==='running'&&row.activity).map(row=>row.activity!);}
  async flush(){await this.tail;if(this.failure)throw this.failure;}
}
