import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { ProductTaskRuntime } from '../src/product/tasks/runtime.ts';
import { TaskEngineHost } from '../src/product/tasks/engine-host.ts';
import { TaskResourceGuard, streamFileHash, copyFileSnapshot, assertImportFileSize } from '../src/product/tasks/resource-guard.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { FileProjection } from '../src/product/tasks/file-projection.ts';
import { taskArtifactPath } from '../src/product/tasks/checkpoint.ts';

const database=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const saved=keys.map(key=>process.env[key]);
let home:string;
let engine:BrainEngine;
beforeAll(async()=>{
  home=mkdtempSync(join(tmpdir(),'pmbrain-resources-'));
  keys.forEach(key=>delete process.env[key]);
  process.env.PMBRAIN_HOME=home;process.env.GBRAIN_HOME=home;
  mkdirSync(join(home,'.pmbrain'));
  writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({engine:database?'postgres':'pglite',model_usage:{embedding_enabled:false,generative_enabled:false}}));
  if(database)assertSafeE2eDatabaseUrl(database);
  engine=database?new PostgresEngine():new PGLiteEngine();
  await engine.connect(database?{database_url:database}:{});await engine.initSchema();
},60000);
afterAll(async()=>{
  await engine?.disconnect();keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
  if(home)rmSync(home,{recursive:true,force:true});
},60000);

test('队列硬上限原子拒绝并发新任务，延迟与暂停任务占用容量，幂等重试与终态不额外占位',async()=>{
  const queue=new MinionQueue(engine);
  const opts={queue:'resource-cap',maxQueueSize:2};
  const first=await queue.add('first',{}, {...opts,delay:86400000,idempotency_key:'resource-first'});
  await engine.executeRaw("UPDATE minion_jobs SET status='paused' WHERE id=$1",[first.id]);
  const submitted=await Promise.allSettled(Array.from({length:8},(_,i)=>queue.add('concurrent-'+i,{},opts)));
  expect(submitted.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  expect(submitted.filter(row=>row.status==='rejected').every(row=>String(row.reason).includes('队列容量'))).toBe(true);
  expect((await queue.add('first',{}, {...opts,idempotency_key:'resource-first'})).id).toBe(first.id);
  await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1",[first.id]);
  expect((await queue.add('after-completion',{},opts)).queue).toBe(opts.queue);
},60000);

test('流式哈希和快照字节一致，空间不足或复制途中取消时不留下半份快照，原资料不变',async()=>{
  const input=join(home,'stream-source.bin');const output=join(home,'stream-snapshot.bin');
  const bytes=Buffer.alloc(3*1024*1024,42);writeFileSync(input,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex');
  expect(await streamFileHash(input)).toBe(hash);
  await copyFileSnapshot(input,output,hash,async()=>{});
  expect(readFileSync(output)).toEqual(bytes);
  const failed=join(home,'stream-failed.bin');
  let checks=0;
  await expect(copyFileSnapshot(input,failed,hash,async()=>{if(++checks===3)throw new Error('模拟空间不足');})).rejects.toThrow('模拟空间不足');
  expect(existsSync(failed)).toBe(false);
  expect(readFileSync(input)).toEqual(bytes);
  const cancelled=join(home,'stream-cancelled.bin');const abort=new AbortController();checks=0;
  await expect(copyFileSnapshot(input,cancelled,hash,async()=>{if(++checks===3)abort.abort(new Error('模拟停止'));abort.signal.throwIfAborted();})).rejects.toThrow('模拟停止');
  expect(existsSync(cancelled)).toBe(false);
  expect(()=>assertImportFileSize('huge.md',6*1024**2)).toThrow('文件过大');
  expect(()=>assertImportFileSize('supported.docx',6*1024**2)).not.toThrow();
});

test('磁盘不足时不开始文件或写入事务，释放空间后同一任务正常写入',async()=>{
  let available=0;
  const guard=new TaskResourceGuard({diskReserveBytes:1024,freeDiskBytes:async()=>available});
  const queue=new MinionQueue(engine);
  const job=await queue.add('resource-disk',{}, {queue:'resource-disk'});
  await queue.claim('resource-disk-token',30000,'resource-disk',['resource-disk']);
  const host=new TaskEngineHost(engine,job.id,'resource-disk-token',async()=>{},false,undefined,guard);
  await expect(host.dispatch({type:'rpc',id:1,method:'task.inputFile',args:[{path:join(home,'source.md'),size:10,mtimeMs:0}]})).rejects.toThrow('磁盘空间不足');
  await expect(host.dispatch({type:'rpc',id:2,method:'transaction.open',args:[]})).rejects.toThrow('磁盘空间不足');
  expect(host.ownsLockedTransaction()).toBe(false);
  available=10*1024*1024;
  await host.dispatch({type:'rpc',id:3,method:'putPage',args:['resource-disk-page',{title:'资源验收',type:'note',compiled_truth:'保留原文',frontmatter:{}}]});
  expect((await engine.getPage('resource-disk-page'))?.title).toBe('资源验收');
  const scope=await host.dispatch({type:'rpc',id:4,method:'transaction.open',args:[]}) as number;
  await host.dispatch({type:'rpc',id:5,scope,method:'putPage',args:['resource-disk-rollback',{title:'应回滚',type:'note',compiled_truth:'未提交内容',frontmatter:{}}]});
  available=0;
  await expect(host.dispatch({type:'rpc',id:6,scope,method:'putPage',args:['resource-disk-next',{title:'不写入',type:'note',compiled_truth:'不写入',frontmatter:{}}]})).rejects.toThrow('磁盘空间不足');
  await host.dispatch({type:'rpc',id:7,scope,method:'scope.close',args:[false]}).catch(()=>{});
  expect(await engine.getPage('resource-disk-rollback')).toBeNull();
  expect((await engine.getPage('resource-disk-page'))?.title).toBe('资源验收');
  await host.close();
},60000);

test('快照容量拒绝超限并在释放后恢复，不会删除原资料来腾空间',async()=>{
  const guard=new TaskResourceGuard({snapshotQuotaBytes:100});
  const release=await guard.reserveSnapshot(70);
  await expect(guard.reserveSnapshot(31)).rejects.toThrow('快照容量');
  release();release();
  await expect(guard.reserveSnapshot(100)).resolves.toBeFunction();
});

test('容量满后拒绝后续文件，已接受文件正常完成释放快照，手动继续认领旧页面',async()=>{
  const dir=join(home,'bounded-scan');mkdirSync(dir);
  const content='# 有界队列\n\n容量不足时保留原文，先完成已经入队的资料。';
  for(const name of ['first.md','second.md','third.md'])writeFileSync(join(dir,name),content+'\n'+name);
  const originals=['first.md','second.md','third.md'].map(name=>readFileSync(join(dir,name)));
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES ('bounded-scan','容量验收',$1,'{}'::jsonb)",[dir]);
  const runtime=new ProductTaskRuntime(engine,{snapshotQuotaBytes:Buffer.byteLength(content+'\nsecond.md')*2});
  await runtime.start();
  async function ended(id:string){
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){const run=await runtime.getRun(id);if(run&&!['running','queued'].includes(run.status))return run;await Bun.sleep(30);}
    throw new Error('容量限制任务未收尾');
  }
  try{
    const run=await runtime.submitDream({preset:'quick',sourceId:'bounded-scan'});
    expect((await ended(run.id)).error).toContain('快照容量');
    const files=await runtime.files(run.id);expect(files?.rows).toHaveLength(2);expect(files?.rows.every(row=>row.status==='completed')).toBe(true);
    await runtime.retry(run.id);
    expect((await ended(run.id)).status).toBe('completed');
    expect((await runtime.files(run.id))?.rows).toHaveLength(3);
    originals.forEach((bytes,index)=>expect(readFileSync(join(dir,['first.md','second.md','third.md'][index]))).toEqual(bytes));
  }finally{await runtime.close();}
},60000);

test('产品两条 Worker 启用 2GB 看门狗，超限后拒绝新任务且没有自动重启',async()=>{
  let memory=0;
  const runtime=new ProductTaskRuntime(engine,{memoryBytes:()=>memory,rssCheckIntervalMs:10});
  await runtime.start();
  try{
    expect((runtime as any).worker.opts.maxRssMb).toBe(2048);
    expect((runtime as any).fileWorker.opts.maxRssMb).toBe(2048);
    memory=3*1024*1024*1024;
    const deadline=Date.now()+3000;
    while(!(runtime as any).failure&&Date.now()<deadline)await Bun.sleep(10);
    await expect(runtime.submitEmbed()).rejects.toThrow('内存');
    expect((runtime as any).paused).toBe(true);
  }finally{await runtime.close();}
},60000);

test('明细日志合并重复活动并压缩，流式重载保留最新状态和旧日志截断行',async()=>{
  const projection=new FileProjection({maxBytes:2048});
  projection.seed(900001,[{id:1,sourceId:'default',path:'source.md',status:'running',error:null}]);
  for(let index=0;index<100;index++){
    projection.activity(900001,1,{id:1,sourceId:'default',path:'source.md',bytes:100,stage:'写入第 '+index+' 批',updatedAt:new Date().toISOString()});
    await projection.flush();
  }
  const path=taskArtifactPath(900001,'files.jsonl');
  expect(readFileSync(path).length).toBeLessThanOrEqual(2048);
  const legacy=readFileSync(path,'utf8')+'{"unfinished":';writeFileSync(path,legacy);
  const reloaded=new FileProjection({maxBytes:2048});await reloaded.load(900001);
  expect(reloaded.details(900001)?.rows[0].activity?.stage).toBe('写入第 99 批');
  for(let id=900002;id<900022;id++){
    reloaded.seed(id,[{id:1,sourceId:'default',path:'old-running.md',status:'running',error:null}]);await reloaded.flush();
  }
  expect((reloaded as any).sessions.size).toBeLessThanOrEqual(16);
  await reloaded.load(900001);
  expect(reloaded.details(900001)?.rows[0].activity?.stage).toBe('写入第 99 批');
  let free=0;
  const low=new FileProjection({resources:new TaskResourceGuard({diskReserveBytes:10,freeDiskBytes:async()=>free})});
  low.seed(900023,[{id:1,sourceId:'default',path:'recover.md',status:'failed',error:'原错误保留'}]);
  await expect(low.flush()).rejects.toThrow('磁盘空间不足');
  free=100*1024**2;await low.recover();await low.flush();
  const restored=new FileProjection();await restored.load(900023);
  expect(restored.details(900023)?.rows[0].error).toBe('原错误保留');
});
