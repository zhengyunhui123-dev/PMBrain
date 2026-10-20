import {expect,test} from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {runPhaseCaptureEntities} from '../src/core/cycle/capture-entities.ts';

test('an empty incremental scope finishes without scanning historical pages or calling a model',async()=>{
  let queries=0;
  const engine={kind:'pglite',executeRaw:async()=>{queries++;throw new Error('empty incremental scope must not scan historical pages');}} as unknown as BrainEngine;
  const result=await runPhaseCaptureEntities(engine,{sourceId:'empty-scope',slugs:[]});
  expect(result.status).toBe('ok');expect(result.details.pages_seen).toBe(0);expect(queries).toBe(0);
});
