import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const testUrl=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;

beforeAll(async () => {
  if(testUrl)assertSafeE2eDatabaseUrl(testUrl);
  engine = testUrl?new PostgresEngine():new PGLiteEngine();
  await engine.connect(testUrl?{database_url:testUrl}:{});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('version','138');
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('personal', 'Personal') ON CONFLICT (id) DO NOTHING`,
  );
  await engine.setConfig('dream.patterns.enabled', 'true');
  await engine.setConfig('dream.patterns.min_evidence', '1');
});

describe('patterns Source scope', () => {
  test('reads only reflections owned by the cycle Source', async () => {
    await engine.putPage('wiki/personal/reflections/default-one', {
      type: 'reflection', title: 'Default', compiled_truth: 'default evidence', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('wiki/personal/reflections/personal-one', {
      type: 'reflection', title: 'Personal', compiled_truth: 'personal evidence', timeline: '', frontmatter: {},
    }, { sourceId: 'personal' });

    const result = await runPhasePatterns(engine, {
      brainDir: '.',
      dryRun: true,
      sourceId: 'personal',
    });

    expect(result.status).toBe('ok');
    expect(result.details.reflections_considered).toBe(1);
  }, 120_000);

  test('相同反思证据不再调用模型，资料更新后允许继续分析',async()=>{
    await engine.putPage('wiki/personal/reflections/personal-one',{
      type:'reflection',title:'反思',compiled_truth:'原始反思证据',timeline:'',frontmatter:{},
    },{sourceId:'personal'});
    const [row]=await engine.executeRaw<{updated_at:Date|string}>("SELECT updated_at FROM pages WHERE source_id='personal' AND slug='wiki/personal/reflections/personal-one'");
    await engine.setConfig('dream.patterns.last_evidence.personal',new Date(row.updated_at).toISOString());
    const unchanged=await runPhasePatterns(engine,{brainDir:'.',dryRun:true,sourceId:'personal',incremental:true});
    expect(unchanged.details.reason).toBe('no_new_evidence');
    await engine.executeRaw("UPDATE pages SET updated_at=updated_at+interval '1 second' WHERE source_id='personal' AND slug='wiki/personal/reflections/personal-one'");
    const changed=await runPhasePatterns(engine,{brainDir:'.',dryRun:true,sourceId:'personal',incremental:true});
    expect(changed.status).toBe('ok');expect(changed.details.reflections_considered).toBe(1);
  },120000);

  test('模式分析成功后复用证据水位，失败不会错误标记完成',async()=>{
    await engine.putPage('wiki/personal/reflections/pattern-live',{
      type:'reflection',title:'隔离反思',compiled_truth:'第一次反思内容',timeline:'',frontmatter:{},
    },{sourceId:'personal'});
    let calls=0;
    const handler=async()=>{calls++;return {result:'没有可确认的新模式'};};
    const opts={brainDir:'.',dryRun:false,sourceId:'personal',incremental:true,_handler:handler};
    const first=await runPhasePatterns(engine,opts);expect(first.status,JSON.stringify(first)).toBe('ok');expect(calls).toBe(1);
    const stamp=await engine.getConfig('dream.patterns.last_evidence.personal');expect(stamp).not.toBeNull();
    expect((await runPhasePatterns(engine,opts)).details.reason).toBe('no_new_evidence');expect(calls).toBe(1);
    await engine.executeRaw("UPDATE pages SET updated_at=updated_at+interval '1 second' WHERE source_id='personal' AND slug='wiki/personal/reflections/pattern-live'");
    const failed=await runPhasePatterns(engine,{...opts,_handler:async()=>{throw new Error('isolated pattern failure');}});
    expect(failed.status).toBe('warn');expect(await engine.getConfig('dream.patterns.last_evidence.personal')).toBe(stamp);
    expect((await runPhasePatterns(engine,opts)).status).toBe('ok');expect(calls).toBe(2);
  },120000);
});
