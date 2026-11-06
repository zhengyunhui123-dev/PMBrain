import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { WorkerPgliteEngine } from '../../src/product/database/worker-engine.ts';

const root=resolve(process.argv[2]??'');
const expected=Number(process.argv[3]);
if(!root.startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('pmbrain-wal-')||!Number.isInteger(expected)||expected<1)throw new Error('invalid isolated crash audit');
process.env.PMBRAIN_HOME=root;
process.env.GBRAIN_HOME=root;
if(process.env.PMBRAIN_AUDIT_ALLOW_REPAIR==='1'){
  delete process.env.PMBRAIN_PGLITE_WAL_REPAIR;
  delete process.env.GBRAIN_PGLITE_WAL_REPAIR;
}else process.env.PMBRAIN_PGLITE_WAL_REPAIR='off';
for(const key of ['DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'])delete process.env[key];
const path=join(root,'brain.pglite');
let engine=new WorkerPgliteEngine() as unknown as BrainEngine;
await engine.connect({database_path:path,require_existing_database:true});
const [before]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_bulk');
if(before.n!==expected)throw new Error(`committed rows mismatch: expected ${expected}, found ${before.n}`);
await engine.executeRaw("INSERT INTO synthetic_wal_bulk VALUES (999999,'write after recovery')");
await engine.disconnect();
engine=new WorkerPgliteEngine() as unknown as BrainEngine;
await engine.connect({database_path:path,require_existing_database:true});
const [after]=await engine.executeRaw<{n:number}>('SELECT count(*)::int AS n FROM synthetic_wal_bulk');
await engine.disconnect();
if(after.n!==expected+1)throw new Error(`reopened rows mismatch: expected ${expected+1}, found ${after.n}`);
console.log(JSON.stringify({event:'recovered',committed:before.n,afterWrite:after.n}));
