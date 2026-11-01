import { expect, test } from 'bun:test';
import { PgliteCheckpointGuard, checkpointGuardThreshold, requestMayWrite, writesWal } from '../src/product/database/checkpoint-guard.ts';

const MB=1024*1024;

test('检查点安全线随 WAL 配置计算，默认提前于自动检查点',()=>{
  expect(checkpointGuardThreshold(1024*MB,16*MB,0.9)).toBe(256*MB);
  expect(checkpointGuardThreshold(160*MB,16*MB,0.9)).toBe(32*MB);
});

test('事务、独立写入和保留连接受保护，读取和生命周期操作不多做检查点',()=>{
  expect(requestMayWrite('@transaction.open',[])).toBe(true);
  expect(requestMayWrite('@withReservedConnection.open',[])).toBe(true);
  expect(requestMayWrite('setConfig',[])).toBe(true);
  expect(requestMayWrite('resolveTake',[])).toBe(true);
  expect(requestMayWrite('executeRaw',['UPDATE config SET value=$1'])).toBe(true);
  expect(writesWal('WITH x AS (DELETE FROM pages RETURNING id) SELECT * FROM x')).toBe(true);
  expect(requestMayWrite('getConfig',['x'])).toBe(false);
  expect(requestMayWrite('executeRaw',['SELECT 1'])).toBe(false);
  expect(requestMayWrite('executeRaw',['CHECKPOINT'])).toBe(false);
  expect(requestMayWrite('connect',[])).toBe(false);
  expect(requestMayWrite('disconnect',[])).toBe(false);
});

test('超过安全线时先完成检查点，再进入下一次写入',async()=>{
  const guard=new PgliteCheckpointGuard();const calls:string[]=[];
  await guard.beforeWrite(async sql=>{
    calls.push(sql);
    if(sql.includes('current_setting'))return [{max_wal:1024*MB,segment:16*MB,target:0.9}];
    if(sql.includes('pg_control_checkpoint'))return [{since_redo:260*MB}];
    return [];
  });
  calls.push('write');
  expect(calls.at(-2)).toBe('CHECKPOINT');
  expect(calls.at(-1)).toBe('write');
});

test('读取检查点位置或执行检查点失败时保留原错误，不开始写入',async()=>{
  for(const fail of ['pg_control_checkpoint','CHECKPOINT']){
    const guard=new PgliteCheckpointGuard();let started=false;
    await expect((async()=>{
      await guard.beforeWrite(async sql=>{
        if(sql.includes(fail))throw new Error(`synthetic ${fail} failure`);
        if(sql.includes('current_setting'))return [{max_wal:1024*MB,segment:16*MB,target:0.9}];
        return [{since_redo:260*MB}];
      });
      started=true;
    })()).rejects.toThrow(`synthetic ${fail} failure`);
    expect(started).toBe(false);
  }
});
