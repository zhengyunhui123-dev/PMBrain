import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGLiteEngine} from '../src/core/pglite-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import type {BrainEngine} from '../src/core/engine';
import {MinionQueue} from '../src/core/minions/queue';
import {SyncFileQueue,SYNC_FILE_QUEUE} from '../src/product/tasks/sync-file-queue';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';

const saved=process.env.PMBRAIN_HOME;process.env.PMBRAIN_HOME=mkdtempSync(join(tmpdir(),'pmbrain-file-cancel-'));
const url=process.env.PMBRAIN_STOP_TEST_DATABASE_URL;let engine:BrainEngine;
beforeAll(async()=>{if(url)assertSafeE2eDatabaseUrl(url);engine=url?new PostgresEngine():new PGLiteEngine();await engine.connect(url?{database_url:url}:{});await engine.initSchema();},60000);
afterAll(async()=>{await engine?.disconnect();if(saved===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=saved;});

test('父任务级联取消后，未完成文件仍能按原编号继续，完成文件与其他会话保持原样',async()=>{
  const queue=new MinionQueue(engine),root=await queue.add('stop-fixture',{}, {queue:'stop-fixture'}),other=await queue.add('stop-other',{}, {queue:'stop-fixture'});
  const pending=await queue.add('file-fixture',{sessionId:root.id,task:{input:{relativePath:'pending.md',hash:'original-hash'}}},{queue:SYNC_FILE_QUEUE,parent_job_id:root.id,delay:86400000,on_child_fail:'continue'});
  const complete=await queue.add('file-fixture',{sessionId:root.id},{queue:SYNC_FILE_QUEUE,parent_job_id:root.id,delay:86400000,on_child_fail:'continue'});
  const foreign=await queue.add('file-fixture',{sessionId:other.id},{queue:SYNC_FILE_QUEUE,parent_job_id:other.id,delay:86400000,on_child_fail:'continue'});
  await engine.executeRaw("UPDATE minion_jobs SET status='completed',result=$2::jsonb,finished_at=now() WHERE id=$1",[complete.id,{status:'imported',chunks:1}]);
  const completedBefore=await queue.getJob(complete.id),foreignBefore=await queue.getJob(foreign.id);
  await queue.cancelJob(root.id);expect((await queue.getJob(pending.id))?.status).toBe('cancelled');
  const files=new SyncFileQueue(engine);await files.pause(root.id);
  expect((await queue.getJob(pending.id))?.status).toBe('paused');
  expect((await queue.getJob(pending.id))?.finished_at).toBeNull();
  expect(await queue.getJob(complete.id)).toEqual(completedBefore);expect(await queue.getJob(foreign.id)).toEqual(foreignBefore);
  await files.resume(root.id);
  const resumed=await queue.getJob(pending.id);expect(resumed?.id).toBe(pending.id);expect(resumed?.status).toBe('delayed');expect(resumed?.data).toEqual(pending.data);
  expect(await queue.getJob(complete.id)).toEqual(completedBefore);expect(await queue.getJob(foreign.id)).toEqual(foreignBefore);
});
