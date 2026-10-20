import {expect,test} from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {withSqlCancellation} from '../src/product/tasks/sql-cancellation.ts';

test('native void cancel retains an observer for the underlying cancellation transport promise',async()=>{
  let observed=0,cancelled=0;
  const query=Promise.resolve([{available:1}]) as any;
  query.canceller=()=>{
    cancelled++;
    const pending=Promise.reject(new Error('isolated cancellation socket reset'));
    const catchError=pending.catch.bind(pending);
    pending.catch=(...args:any[])=>{observed++;return catchError(...args);};
    return pending;
  };
  query.cancel=()=>{if(query.canceller){query.canceller(query);query.canceller=null;}};
  const sql=Object.assign(()=>query,{unsafe:()=>query});
  const engine={kind:'postgres',sql,executeRaw:async function(this:any){return await this.sql.unsafe('SELECT 1');}} as unknown as BrainEngine;
  const abort=new AbortController();abort.abort();
  expect(await withSqlCancellation(engine,abort.signal).executeRaw('SELECT 1')).toEqual([{available:1}]);
  await Bun.sleep(0);expect(cancelled).toBe(1);expect(observed).toBe(1);
});
