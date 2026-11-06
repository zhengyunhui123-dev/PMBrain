import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configPath } from '../src/core/config.ts';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine.ts';

const keys = ['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'];
const saved = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const MB = 1024 * 1024;
let root = '';
let engine: BrainEngine;

beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-wal-guard-'));
  for(const key of keys)delete process.env[key];
  process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
  mkdirSync(join(root,'.pmbrain'));
  writeFileSync(configPath(),JSON.stringify({engine:'pglite'}));
  engine=new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({database_path:join(root,'brain.pglite')});
  await engine.executeRaw("ALTER SYSTEM SET max_wal_size = '160MB'");
  await engine.executeRaw('CREATE TABLE synthetic_wal_guard (id int, payload text)');
  await engine.disconnect();
  engine=new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({database_path:join(root,'brain.pglite')});
},90000);

afterAll(async()=>{
  await engine?.disconnect();
  for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  if(root){
    const path=resolve(root),temp=resolve(tmpdir());
    if(!path.startsWith(temp+sep)||!basename(path).startsWith('pmbrain-wal-guard-'))throw new Error('隔离目录不匹配');
    rmSync(path,{recursive:true,force:true});
  }
},30000);

test('WAL 接近阈值时自动检查点在独立写入和事务之前完成，重启后数据保留',async()=>{
  expect(String((await engine.executeRaw<{max_wal_size:string}>('SHOW max_wal_size'))[0].max_wal_size)).toBe('160MB');
  let id=0;
  for(const mode of ['autocommit','transaction','reserved'] as const){
    await engine.executeRaw('CHECKPOINT');
    const [initial]=await engine.executeRaw<{redo:string;lsn:string}>('SELECT redo_lsn::text AS redo, pg_current_wal_lsn()::text AS lsn FROM pg_control_checkpoint()');
    let bytes=0;
    const fill=async(connection:Pick<BrainEngine,'executeRaw'>)=>{
      while(bytes<36*MB && id<200000){
        const write=async(tx:Pick<BrainEngine,'executeRaw'>)=>tx.executeRaw("INSERT INTO synthetic_wal_guard SELECT $1::int+g, md5(g::text || $1::text) || repeat('x',900) FROM generate_series(1,1000) g",[id]);
        if(mode==='transaction')await engine.transaction(write);else await write(connection);
        id+=1000;
        const [current]=await connection.executeRaw<{bytes:number}>('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::float8 AS bytes',[initial.lsn]);
        bytes=Number(current.bytes);
      }
    };
    if(mode==='reserved')await engine.withReservedConnection(fill);else await fill(engine);
    expect(bytes).toBeGreaterThanOrEqual(36*MB);
    expect(bytes).toBeLessThan(48*MB);
    const [after]=await engine.executeRaw<{redo:string}>('SELECT redo_lsn::text AS redo FROM pg_control_checkpoint()');
    expect(after.redo).not.toBe(initial.redo);
  }
  const [before]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard');
  expect(before.n).toBe(id);
  await engine.disconnect();engine=new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({database_path:join(root,'brain.pglite')});
  const [after]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard');
  expect(after.n).toBe(id);
},240000);

test('检查点保护不改变失败事务回滚或后续事务',async()=>{
  await expect(engine.transaction(async tx=>{
    await tx.executeRaw("INSERT INTO synthetic_wal_guard VALUES (-1,'rollback')");
    throw new Error('synthetic rollback');
  })).rejects.toThrow('synthetic rollback');
  const [rolledBack]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard WHERE id=-1');
  expect(rolledBack.n).toBe(0);
  await engine.transaction(async tx=>{await tx.executeRaw("INSERT INTO synthetic_wal_guard VALUES (-2,'committed')");});
  const [committed]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard WHERE id=-2');
  expect(committed.n).toBe(1);
},30000);

test('连续写入超过多个自动检查点周期后完成，重开数据库保留全部数据',async()=>{
  await engine.executeRaw('CHECKPOINT');
  const [initial]=await engine.executeRaw<{lsn:string;redo:string}>('SELECT pg_current_wal_lsn()::text AS lsn, redo_lsn::text AS redo FROM pg_control_checkpoint()');
  let previousRedo=initial.redo,checkpoints=0,bytes=0;
  for(let i=0;i<200;i++){
    await engine.executeRaw("INSERT INTO synthetic_wal_guard SELECT 1000000+$1::int*1000+g, md5(g::text || $1::text) || repeat('x',900) FROM generate_series(1,1000) g",[i]);
    if((i+1)%10===0){
      const [position]=await engine.executeRaw<{wal:number;redo:string}>('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::float8 AS wal, redo_lsn::text AS redo FROM pg_control_checkpoint()',[initial.lsn]);
      bytes=Number(position.wal);
      if(position.redo!==previousRedo){checkpoints++;previousRedo=position.redo;}
    }
  }
  expect(bytes).toBeGreaterThan(160*MB);
  expect(checkpoints).toBeGreaterThanOrEqual(3);
  const [before]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard WHERE id>1000000');
  expect(before.n).toBe(200000);
  await engine.disconnect();engine=new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({database_path:join(root,'brain.pglite')});
  const [after]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard WHERE id>1000000');
  expect(after.n).toBe(200000);
},300000);

test('单笔写入超过自动检查点触发距离仍完成，并在下一次写入前整理日志',async()=>{
  await engine.executeRaw('CHECKPOINT');
  const [initial]=await engine.executeRaw<{lsn:string;redo:string}>('SELECT pg_current_wal_lsn()::text AS lsn, redo_lsn::text AS redo FROM pg_control_checkpoint()');
  await engine.executeRaw("INSERT INTO synthetic_wal_guard SELECT 2000000+g, md5(g::text) || repeat('y',900) FROM generate_series(1,90000) g");
  const [position]=await engine.executeRaw<{wal:number;redo:string}>('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::float8 AS wal, redo_lsn::text AS redo FROM pg_control_checkpoint()',[initial.lsn]);
  expect(Number(position.wal)).toBeGreaterThan(80*MB);
  expect(position.redo).toBe(initial.redo);
  await engine.executeRaw("INSERT INTO synthetic_wal_guard VALUES (3000000,'next write')");
  const [after]=await engine.executeRaw<{redo:string}>('SELECT redo_lsn::text AS redo FROM pg_control_checkpoint()');
  expect(after.redo).not.toBe(initial.redo);
  await engine.disconnect();engine=new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect({database_path:join(root,'brain.pglite')});
  const [count]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard WHERE id>2000000');
  expect(count.n).toBe(90001);
},180000);

test('大事务内使用保留连接继续写入，不在事务内执行检查点',async()=>{
  await engine.executeRaw('CHECKPOINT');
  const [initial]=await engine.executeRaw<{lsn:string;redo:string}>('SELECT pg_current_wal_lsn()::text AS lsn, redo_lsn::text AS redo FROM pg_control_checkpoint()');
  await engine.transaction(async tx=>{
    await tx.executeRaw("INSERT INTO synthetic_wal_guard SELECT 4000000+g, md5(g::text) || repeat('z',900) FROM generate_series(1,40000) g");
    const [position]=await tx.executeRaw<{wal:number}>('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::float8 AS wal',[initial.lsn]);
    expect(Number(position.wal)).toBeGreaterThan(32*MB);
    await tx.withReservedConnection(async connection=>{
      await connection.executeRaw("INSERT INTO synthetic_wal_guard VALUES (5000000,'reserved inside transaction')");
    });
    const [checkpoint]=await tx.executeRaw<{redo:string}>('SELECT redo_lsn::text AS redo FROM pg_control_checkpoint()');
    expect(checkpoint.redo).toBe(initial.redo);
  });
  const [count]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_guard WHERE id>4000000');
  expect(count.n).toBe(40001);
},180000);
