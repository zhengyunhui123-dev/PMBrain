import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadConfigWithEngine } from '../src/core/config.ts';
import { loadQuickConfigSnapshot } from '../src/product/tasks/quick-config-snapshot.ts';

test('快速维护单次批量读取配置，下一份文件读取最新设置并保留配置优先级',async()=>{
  const values=new Map<string,string>([
    ['content_sanity.bytes_warn','1234'],
    ['content_sanity.disabled','true'],
    ['ocr_enabled','true'],
    ['dream.patterns.lookback_days','12'],
    ['other.key','dynamic'],
  ]);
  let batches=0,individual=0;
  const engine={
    kind:'pglite',
    executeRaw:async(_sql:string,args:unknown[])=>{
      batches++;
      return (args[0] as string[]).filter(key=>values.has(key)).map(key=>({key,value:values.get(key)}));
    },
    getConfig:async(key:string)=>{individual++;return values.get(key)??null;},
  } as unknown as BrainEngine;
  const first=await loadQuickConfigSnapshot(engine);
  const merged=await loadConfigWithEngine(first,{engine:'pglite',content_sanity:{bytes_warn:999}});
  expect(merged?.content_sanity).toMatchObject({bytes_warn:999,disabled:true});
  expect(merged?.ocr_enabled).toBe(true);
  expect(merged?.dream?.patterns?.lookback_days).toBe(12);
  expect(batches).toBe(1);
  expect(individual).toBe(0);
  expect(await first.getConfig('other.key')).toBe('dynamic');
  expect(individual).toBe(1);
  values.set('content_sanity.disabled','false');
  const second=await loadQuickConfigSnapshot(engine);
  expect((await loadConfigWithEngine(second,{engine:'pglite'}))?.content_sanity?.disabled).toBe(false);
  expect(batches).toBe(2);
});

test('批量读取失败时保持原有逐项读取行为',async()=>{
  let reads=0;
  const engine={kind:'pglite',executeRaw:async()=>{throw new Error('fixture');},getConfig:async(key:string)=>{reads++;return key==='ocr_enabled'?'true':null;}} as unknown as BrainEngine;
  const snapshot=await loadQuickConfigSnapshot(engine);
  expect((await loadConfigWithEngine(snapshot,{engine:'pglite'}))?.ocr_enabled).toBe(true);
  expect(reads).toBeGreaterThan(1);
});
