import {expect,test} from 'bun:test';
import {prepareDreamKnowledge} from '../src/product/tasks/dream-knowledge';
import type {BrainEngine} from '../src/core/engine';

function fixture(initial:Record<string,string>={}){
  const values=new Map(Object.entries(initial));
  const engine={getConfig:async(key:string)=>values.get(key)??null,setConfig:async(key:string,value:string)=>{values.set(key,value);},transaction:async(fn:(tx:BrainEngine)=>unknown)=>fn(engine as unknown as BrainEngine)};
  return {engine:engine as unknown as BrainEngine,values};
}
test('deep organization is enabled without first saving a setting',async()=>{
  const {engine,values}=fixture();
  expect(await prepareDreamKnowledge(engine)).toBe(true);
  expect(values.get('dream.knowledge.enabled')).toBe('true');
  expect(values.get('dream.synthesize.conversation_pages')).toBe('true');
  expect(values.get('dream.synthesize.enabled')).toBe('true');
  expect(values.has('dream.knowledge.since')).toBe(false);
});
test('an explicitly disabled switch and advanced input choices are preserved',async()=>{
  const disabled=fixture({'dream.knowledge.enabled':'false'});
  expect(await prepareDreamKnowledge(disabled.engine)).toBe(false);
  expect(disabled.values.size).toBe(1);
  const advanced=fixture({'dream.synthesize.conversation_pages':'false','dream.knowledge.since':'2026-10-20T00:00:00Z'});
  expect(await prepareDreamKnowledge(advanced.engine)).toBe(true);
  expect(advanced.values.get('dream.synthesize.conversation_pages')).toBe('false');
  expect(advanced.values.get('dream.knowledge.since')).toBe('2026-10-20T00:00:00Z');
});
