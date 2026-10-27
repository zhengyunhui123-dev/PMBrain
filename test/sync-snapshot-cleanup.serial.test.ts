import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import type {BrainEngine} from '../src/core/engine';
import {SyncFileQueue} from '../src/product/tasks/sync-file-queue';
import {gbrainPath} from '../src/core/config';
let root:string;
const keys=['PMBRAIN_HOME','GBRAIN_HOME'];const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
beforeAll(()=>{root=mkdtempSync(join(tmpdir(),'pmbrain-snapshot-cleanup-'));process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;});
afterAll(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!root.includes('pmbrain-snapshot-cleanup-'))throw new Error('临时路径校验失败');rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
test('并发完成通知只能清理自己的快照，重复通知与非空目录不影响其他文件',async()=>{
  const queue=new SyncFileQueue({} as BrainEngine);const folder=join(gbrainPath('task-artifacts'),'sync-files','isolated','1');mkdirSync(folder,{recursive:true});
  const path=join(folder,'a'.repeat(64)+'-first.md');const other=join(folder,'b'.repeat(64)+'-other.md');writeFileSync(path,'snapshot');writeFileSync(other,'retain');
  const job={status:'completed',result:{status:'imported'},data:{sessionId:1,task:{input:{path}}}} as any;
  await Promise.all(Array.from({length:16},()=>queue.cleanupCompleted(job)));
  expect(existsSync(path)).toBe(false);expect(readFileSync(other,'utf8')).toBe('retain');
  job.data.task.input.path=other;await Promise.all(Array.from({length:16},()=>queue.cleanupCompleted(job)));expect(existsSync(folder)).toBe(false);
});
test('清理拒绝任务目录外的路径，原始资料保留',async()=>{
  const original=join(root,'original.md');writeFileSync(original,'original source');const queue=new SyncFileQueue({} as BrainEngine);
  await expect(queue.cleanupCompleted({status:'completed',result:{status:'imported'},data:{sessionId:1,task:{input:{path:original}}}} as any)).rejects.toThrow('清理路径无效');expect(readFileSync(original,'utf8')).toBe('original source');
});
