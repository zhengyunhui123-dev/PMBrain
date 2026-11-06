import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { WorkerPgliteEngine } from '../../src/product/database/worker-engine.ts';

const root = resolve(process.argv[2] ?? '');
const mode = process.argv[3];
const batches = Number(process.argv[4] ?? '200');
const walMax=process.argv[5]??'64MB';
const moduleRoot=process.argv[6]?resolve(process.argv[6]):'';
const rowsPerBatch=Number(process.env.PMBRAIN_WAL_EXPERIMENT_ROWS??'1000');
if (!root.startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('pmbrain-') || !['guarded','unguarded','latest'].includes(mode ?? '') || !['64MB','1GB'].includes(walMax) || !Number.isInteger(batches) || batches < 1 || batches > 1200
  || !Number.isInteger(rowsPerBatch) || rowsPerBatch<1 || rowsPerBatch>100000 || (mode==='latest'&&!moduleRoot.startsWith(resolve(tmpdir())+sep))) throw new Error('invalid isolated WAL experiment');
process.env.PMBRAIN_HOME = root;
process.env.GBRAIN_HOME = root;
for (const key of ['DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL']) delete process.env[key];
mkdirSync(join(root,'.pmbrain'),{recursive:true});
writeFileSync(join(root,'.pmbrain','config.json'),JSON.stringify({engine:'pglite'}));
const path=join(root,'brain.pglite');
const latest=mode==='latest'?(await import(pathToFileURL(join(moduleRoot,'node_modules','@electric-sql','pglite','dist','index.js')).href)).PGlite:undefined;
const makeEngine=()=>{
  if(mode==='guarded')return new WorkerPgliteEngine() as unknown as BrainEngine;
  if(mode==='latest'){
    let db:any;
    return {kind:'pglite',connect:async(config:{database_path:string})=>{
      db=await latest.create({dataDir:config.database_path});
      await db.exec('SET max_parallel_workers = 0; SET max_parallel_workers_per_gather = 0; SET jit = off;');
    },executeRaw:async(sql:string,params?:unknown[])=>(await db.query(sql,params)).rows,disconnect:async()=>db.close()} as unknown as BrainEngine;
  }
  return new PGLiteEngine();
};
let engine=makeEngine();
await engine.connect({database_path:path});
await engine.executeRaw(`ALTER SYSTEM SET max_wal_size = '${walMax}'`);
await engine.executeRaw('CREATE TABLE synthetic_wal_bulk (id int, value text)');
await engine.disconnect();
engine=makeEngine();
await engine.connect({database_path:path});
await engine.executeRaw('CHECKPOINT');
if(mode==='unguarded' && process.env.PMBRAIN_WAL_EXPERIMENT_DEBUG==='1'){
  ((engine as PGLiteEngine).db as unknown as {debug:number}).debug=1;
  await engine.executeRaw("SET client_min_messages='debug1'");
  await engine.executeRaw("SET log_min_messages='debug1'");
}
const [initial]=await engine.executeRaw<{lsn:string;redo:string}>('SELECT pg_current_wal_lsn()::text AS lsn, redo_lsn::text AS redo FROM pg_control_checkpoint()');
const settings=await engine.executeRaw<{name:string;setting:string}>("SELECT name, setting FROM pg_settings WHERE name IN ('server_version','shared_buffers','max_wal_size','checkpoint_completion_target') ORDER BY name");
console.log(JSON.stringify({event:'started',mode,initial,settings}));
let previousRedo=initial.redo, checkpoints=0, bytes=0;
for(let i=0;i<batches;i++){
  await engine.executeRaw("INSERT INTO synthetic_wal_bulk SELECT $1::int*$2::int+g, md5(g::text || $1::text) || repeat('x',900) FROM generate_series(1,$2::int) g",[i,rowsPerBatch]);
  if((i+1)%10===0||i+1===batches){
    const [position]=await engine.executeRaw<{wal:number;redo:string}>('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::float8 AS wal, redo_lsn::text AS redo FROM pg_control_checkpoint()',[initial.lsn]);
    bytes=Number(position.wal);
    if(position.redo!==previousRedo){checkpoints++;previousRedo=position.redo;}
    console.log(JSON.stringify({event:'progress',mode,batches:i+1,walBytes:bytes,checkpoints}));
  }
}
const [count]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_bulk');
await engine.disconnect();
engine=makeEngine();
await engine.connect({database_path:path});
const [reopened]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_bulk');
await engine.disconnect();
console.log(JSON.stringify({event:'completed',mode,batches,walBytes:bytes,checkpoints,before:count.n,after:reopened.n}));
