import { afterAll, beforeAll, beforeEach, expect, test, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resolveDreamModel } from '../src/core/cycle/model-routing.ts';
import { loadActivePack } from '../src/core/schema-pack/load-active.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import {prepareDreamKnowledge} from '../src/product/tasks/dream-knowledge';

let engine: BrainEngine;
let home: string;
const previousHome=process.env.PMBRAIN_HOME;
if(process.env.PMBRAIN_DREAM_TEST_POSTGRES==='1')setDefaultTimeout(60_000);
const text='项目组约定，每次发布前先保存原始测试证据，再核对功能完成情况，避免把测试通过误当成用户目标已经实现。';
const seedBody=text+'\n'+'补充上下文描述了项目资料的保存与检查流程。'.repeat(45);
const result=(body:unknown):ChatResult=>({text:typeof body==='string'?body:JSON.stringify(body),blocks:[],stopReason:'end',usage:{input_tokens:100,output_tokens:30,cache_read_tokens:0,cache_creation_tokens:0},model:'mimo:mimo-v2.6-flash',providerId:'mimo'});

beforeAll(async()=>{
  home=mkdtempSync(join(tmpdir(),'pmbrain-dream-knowledge-'));
  mkdirSync(join(home,'.pmbrain'));
  writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({engine:'pglite',schema_pack:'gbrain-base-v2',embedding_disabled:true,models:{default:'mimo:mimo-v2.6-flash'}}));
  process.env.PMBRAIN_HOME=home;
  configureGateway({env:{},generative_enabled:false});
  if(process.env.PMBRAIN_DREAM_TEST_POSTGRES==='1'){
    const url=process.env.DATABASE_URL??'';assertSafeE2eDatabaseUrl(url);
    const {PostgresEngine}=await import('../src/core/postgres-engine.ts');
    engine=new PostgresEngine();await engine.connect({database_url:url});
  }else{engine=new PGLiteEngine();await engine.connect({});}
  await engine.initSchema();
},120_000);
beforeEach(async()=>{await resetPgliteState(engine as PGLiteEngine);},60_000);
afterAll(async()=>{await engine.disconnect();resetGateway();if(previousHome===undefined)delete process.env.PMBRAIN_HOME;else process.env.PMBRAIN_HOME=previousHome;rmSync(home,{recursive:true,force:true});},60_000);

async function seed(slug:string,type:string,frontmatter:Record<string,unknown>={},sourceId='default'){
  await engine.putPage(slug,{type:type as never,title:slug,compiled_truth:seedBody,timeline:'',frontmatter},{sourceId});
}

test('ordinary note pages participate in native pack-declared atom discovery',async()=>{
  await seed('notes/release','note');await seed('concepts/output','concept');
  const pages=await discoverExtractablePages(engine,'default');
  expect(pages.map(p=>p.slug)).toEqual(['notes/release']);
});

test('default deep knowledge is persisted by execution and explicit disabling remains effective',async()=>{
  expect(await prepareDreamKnowledge(engine)).toBe(true);
  expect(await engine.getConfig('dream.synthesize.conversation_pages')).toBe('true');
  expect(await engine.getConfig('dream.knowledge.since')).toBeNull();
  await engine.setConfig('dream.knowledge.enabled','false');
  expect(await prepareDreamKnowledge(engine)).toBe(false);
});

test('compatible knowledge pack preserves the active taxonomy and explicit model mode wins over stale stage overrides',async()=>{
  const pack=await loadActivePack({cfg:{engine:'pglite',schema_pack:'gbrain-base-v2'},remote:false,perCall:'pmbrain-knowledge'});
  expect(pack.manifest.phases).toEqual(['extract_atoms','synthesize_concepts']);
  expect(pack.manifest.page_types.some(p=>p.name==='note')).toBe(true);
  await engine.setConfig('models.dream.synthesize','anthropic:claude-sonnet-4-6');
  await engine.setConfig('models.default','mimo:mimo-v2.6-flash');
  await engine.setConfig('dream.knowledge.enabled','true');
  expect((await resolveDreamModel(engine,{phase:'synthesize'})).model).toBe('mimo:mimo-v2.6-flash');
  await engine.setConfig('dream.knowledge.use_ordinary_model','false');
  expect((await resolveDreamModel(engine,{phase:'synthesize'})).model).toBe('anthropic:claude-sonnet-4-6');
});

test('activation cutoff leaves historical inputs untouched and queue count matches discovery',async()=>{
  await seed('notes/old','note');await engine.executeRaw("UPDATE pages SET updated_at='2026-01-01' WHERE slug='notes/old'");
  await seed('notes/new','note');
  const scope={since:'2026-10-01T00:00:00Z'};
  expect((await discoverExtractablePages(engine,'default',undefined,scope)).map(p=>p.slug)).toEqual(['notes/new']);
  const {countExtractAtomsBacklog}=await import('../src/core/cycle/extract-atoms.ts');
  expect(await countExtractAtomsBacklog(engine,'default',scope)).toBe(1);
});

test('discovery excludes private pages and generated backups',async()=>{
  await seed('notes/public','note');await seed('notes/private','note',{visibility:'private'});
  await seed('output/wiki-health/backups/notes/old','source');
  await seed('notes/generated','note',{dream_generated:true});
  expect((await discoverExtractablePages(engine,'default')).map(p=>p.slug)).toEqual(['notes/public']);
});

test('database conversations have an explicit source-scoped native synthesis input',async()=>{
  const discovery=await import('../src/core/cycle/transcript-discovery.ts');
  expect(typeof (discovery as any).withConversationPages).toBe('function');
  await seed('conversations/original','conversation');
  await seed('conversations/private','conversation',{visibility:'private'});
  await seed('conversations/derived','conversation',{dream_generated:true});
  await engine.setConfig('dream.synthesize.conversation_pages','true');
  const pages=await (discovery as any).withConversationPages(engine,{sourceId:'default'},{corpusDir:null,minChars:500,excludePatterns:[]},[]);
  expect(pages).toHaveLength(1);expect(pages[0].filePath).toContain('conversations/original');
  expect(pages[0].content).toBe(seedBody);
  await engine.setConfig('dream.synthesize.conversation_pages','false');
  expect(await (discovery as any).withConversationPages(engine,{sourceId:'default'},{corpusDir:null,minChars:500,excludePatterns:[]},[])).toEqual([]);
});

test('Chinese concept names and source quotes survive extraction and remain independently incremental',async()=>{
  await seed('notes/release','note');let calls=0;
  const chat=async()=>{calls++;return result([{title:'发布前核验证据',atom_type:'insight',body:text,source_quote:text,concepts:['证据驱动发布']}]);};
  const first=await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
  expect(first.details.atoms_extracted).toBe(1);
  const atoms=await engine.executeRaw<{slug:string;frontmatter:any}>("SELECT slug,frontmatter FROM pages WHERE type='atom'");
  expect(atoms[0].frontmatter.concepts).toEqual(['证据驱动发布']);
  expect(atoms[0].frontmatter.source_quote_verified).toBe(true);
  await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
  expect(calls).toBe(1);
  await seed('notes/release','note',{version:2});
  await engine.executeRaw("UPDATE pages SET compiled_truth=compiled_truth||'后来追加验收要求',content_hash='changed-release-hash' WHERE slug='notes/release'");
  await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
  expect(calls).toBe(2);
});

test('concept synthesis reuses an unchanged evidence receipt and preserves existing facts and timeline',async()=>{
  const atoms=Array.from({length:5},(_,i)=>({slug:`atoms/evidence-${i}`,source_id:'default',title:`证据${i}`,body:text,concept_refs:['release-evidence']}));
  for(const atom of atoms)await seed(atom.slug,'atom',{concepts:atom.concept_refs});
  const original='人工维护的项目结论。\n\n## Facts\n\n原有事实必须保留。';
  await engine.putPage('concepts/release-evidence',{type:'concept',title:'发布证据',compiled_truth:original,timeline:'- **2026-10-01** | 人工记录',frontmatter:{manual_marker:true}});
  let calls=0;const chat=async()=>{calls++;return result('先保存证据，再判断是否满足发布条件。');};
  const first=await runPhaseSynthesizeConcepts(engine,{sourceId:'default',_atoms:atoms,_chat:chat});
  const page=await engine.getPage('concepts/release-evidence');
  expect(page?.compiled_truth).toContain('原有事实必须保留');expect(page?.timeline).toContain('人工记录');expect(page?.frontmatter.manual_marker).toBe(true);
  await runPhaseSynthesizeConcepts(engine,{sourceId:'default',_atoms:atoms,_chat:chat});
  expect(calls).toBe(1);expect(first.status).toBe('ok');
});

test('a failed second atom rolls back the whole item and retry can publish every atom',async()=>{
  await seed('notes/atomic','note');
  await engine.executeRaw("CREATE FUNCTION reject_dream_atom_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='atom' AND NEW.title='第二条知识点' THEN RAISE EXCEPTION 'injected atom publication failure'; END IF; RETURN NEW; END $$");
  await engine.executeRaw('CREATE TRIGGER reject_dream_atom_test BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION reject_dream_atom_test()');
  const chat=async()=>result([{title:'第一条知识点',atom_type:'insight',body:text,source_quote:text,concepts:['证据发布']},{title:'第二条知识点',atom_type:'insight',body:text,source_quote:text,concepts:['证据发布']}]);
  try{
    const failed=await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
    expect(failed.status).toBe('warn');
    expect((await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM pages WHERE type='atom'"))[0].n).toBe(0);
    expect((await engine.getPage('notes/atomic'))?.compiled_truth).toBe(seedBody);
  }finally{await engine.executeRaw('DROP TRIGGER reject_dream_atom_test ON pages');await engine.executeRaw('DROP FUNCTION reject_dream_atom_test()');}
  const retried=await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
  expect(retried.details.atoms_extracted).toBe(2);expect(retried.details.pages_remaining).toBe(0);
});

test('a native budget stop retains a completed page and resumes only the remaining page',async()=>{
  await seed('notes/first','note');await seed('notes/second','note');
  await engine.executeRaw("UPDATE pages SET compiled_truth=compiled_truth||'第二份不同材料',content_hash='second-item-native-budget-hash' WHERE slug='notes/second'");
  let calls=0;
  const chat=async()=>{calls++;if(calls===2)throw new BudgetExhausted('native budget stop',{reason:'cost',spent:0.3,cap:0.3});return result([{title:'预算内的知识点',atom_type:'insight',body:text,source_quote:text,concepts:['证据发布']}]);};
  const first=await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
  expect(first.status).toBe('warn');expect(first.details.pages_remaining).toBe(1);
  const resumed=await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:chat});
  expect(resumed.details.pages_remaining).toBe(0);expect(calls).toBe(3);
});

test('a source edited during extraction is preserved and remains pending',async()=>{
  await seed('notes/concurrent','note');
  const first=await runPhaseExtractAtoms(engine,{sourceId:'default',_transcripts:[],_chat:async()=>{
    await engine.executeRaw("UPDATE pages SET compiled_truth='用户刚保存的新正文',content_hash='user-edited' WHERE slug='notes/concurrent'");
    return result([{title:'旧材料知识点',atom_type:'insight',body:text,source_quote:text}]);
  }});
  expect(first.status).toBe('warn');
  expect((await engine.getPage('notes/concurrent'))?.compiled_truth).toBe('用户刚保存的新正文');
  expect((await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM pages WHERE type='atom'"))[0].n).toBe(0);
});

test('concept publication rejects evidence changed during the model call',async()=>{
  for(let i=0;i<5;i++)await seed(`atoms/live-${i}`,'atom',{concepts:['live-evidence']});
  await expect(runPhaseSynthesizeConcepts(engine,{sourceId:'default',_chat:async()=>{
    await seed('atoms/live-0','atom',{concepts:['different-evidence']});
    return result('依据旧证据的综合');
  }})).rejects.toThrow('concept_evidence_conflict');
  expect(await engine.getPage('concepts/live-evidence')).toBeNull();
});

test('product knowledge extraction keeps unsupported quotations pending',async()=>{
  await seed('notes/unsupported','note');
  const phase=await runPhaseExtractAtoms(engine,{sourceId:'default',since:'2026-10-01T00:00:00Z',_transcripts:[],_chat:async()=>result([{title:'没有证据的断言',atom_type:'insight',body:'所有任务均已成功。',source_quote:'来源中没有这句话'}])});
  expect(phase.status).toBe('warn');expect(phase.details.pages_remaining).toBe(1);
  expect((await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM pages WHERE type='atom'"))[0].n).toBe(0);
});

test('superseded source revisions are retained as history and excluded from current concept evidence',async()=>{
  await seed('notes/revised','note');
  const source=await engine.getPage('notes/revised');
  for(let i=0;i<2;i++)await seed(`atoms/old-${i}`,'atom',{concepts:['old-evidence'],source_slug:'notes/revised',source_hash:source!.content_hash!.slice(0,16)});
  await engine.executeRaw("UPDATE pages SET content_hash='new-source-version' WHERE slug='notes/revised'");
  const phase=await runPhaseSynthesizeConcepts(engine,{sourceId:'default',_chat:async()=>{throw new Error('superseded evidence must not call the model');}});
  expect(phase.status).toBe('skipped');expect(await engine.getPage('concepts/old-evidence')).toBeNull();
  expect((await engine.executeRaw<{n:number}>("SELECT count(*)::int n FROM pages WHERE type='atom'"))[0].n).toBe(2);
});

test('first activation does not synthesize untouched historical concept groups',async()=>{
  for(let i=0;i<5;i++)await seed(`atoms/historical-${i}`,'atom',{concepts:['historical-only']});
  await engine.executeRaw("UPDATE pages SET updated_at='2026-01-01' WHERE type='atom'");
  const phase=await runPhaseSynthesizeConcepts(engine,{sourceId:'default',since:'2026-10-01T00:00:00Z',_chat:async()=>{throw new Error('Historical group must stay untouched');}});
  expect(phase.status).toBe('skipped');expect(await engine.getPage('concepts/historical-only')).toBeNull();
});
