import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import type {BrainEngine} from '../src/core/engine';
import {WorkerPgliteEngine} from '../src/product/database/worker-engine';
import {PostgresEngine} from '../src/core/postgres-engine';
import {runQuickMaintenance} from '../src/core/quick-maintenance';
import type {PhaseResult} from '../src/core/cycle';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard';

let engine:BrainEngine,root:string;
const databaseUrl=process.env.PMBRAIN_TASK_TEST_DATABASE_URL;
const keys=['PMBRAIN_HOME','GBRAIN_HOME','DATABASE_URL','GBRAIN_DATABASE_URL','PMBRAIN_DATABASE_URL'];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
beforeAll(async()=>{
  root=mkdtempSync(join(tmpdir(),'pmbrain-relation-completion-'));
  for(const key of keys)delete process.env[key];
  process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;mkdirSync(join(root,'.pmbrain'));
  writeFileSync(join(root,'.pmbrain','config.json'),JSON.stringify({engine:databaseUrl?'postgres':'pglite',model_usage:{generative_enabled:false,embedding_enabled:false}}));
  if(databaseUrl)assertSafeE2eDatabaseUrl(databaseUrl);
  engine=databaseUrl?new PostgresEngine():new WorkerPgliteEngine() as unknown as BrainEngine;
  await engine.connect(databaseUrl?{database_url:databaseUrl}:{});await engine.initSchema();
},60000);
afterAll(async()=>{
  await engine?.disconnect();
  for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  if(root&&resolve(root).startsWith(resolve(tmpdir())+sep)&&root.includes('pmbrain-relation-completion-'))rmSync(root,{recursive:true,force:true});
},60000);

async function fixture(sourceId:string,count:number){
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[sourceId]);
  const entities=[['people/chen','person','陈明'],['projects/river','project','清河项目'],['organizations/team','organization','远山团队'],['companies/cloud','company','云海公司']];
  for(const [slug,type,title] of entities)await engine.putPage(slug,{type,title,compiled_truth:'已有实体的知识保持原样。',timeline:'',frontmatter:{}},{sourceId});
  const slugs=Array.from({length:count},(_,i)=>`notes/item-${i}`);
  for(const slug of [...slugs,'notes/unchanged-history'])await engine.putPage(slug,{type:'note',title:slug,compiled_truth:'陈明负责清河项目，远山团队和云海公司参与。参见 [[people/chen]]。',timeline:'',frontmatter:{}},{sourceId});
  const sync:PhaseResult={phase:'sync',status:'ok',duration_ms:0,summary:'本轮增量已导入',details:{},pagesAffected:slugs} as PhaseResult;
  return {slugs,sync};
}
async function linkedPages(sourceId:string){return engine.executeRaw<{slug:string;targets:number}>(`SELECT p.slug,count(DISTINCT t.id)::int targets FROM pages p JOIN links l ON l.from_page_id=p.id JOIN pages t ON t.id=l.to_page_id
  WHERE p.source_id=$1 AND p.slug LIKE 'notes/%' GROUP BY p.slug ORDER BY p.slug`,[sourceId]);}

test('超过200页且名称表准备超过5秒，一次快速维护完成全部本轮关联',async()=>{
  const sourceId='relation-complete';const {slugs,sync}=await fixture(sourceId,205);
  let delayed=false;
  const slow=new Proxy(engine,{get(target,key){
    if(key==='getConfig')return async(name:string)=>{if(name==='mentions.auto_link'&&!delayed){delayed=true;await Bun.sleep(5200);}return target.getConfig(name);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const report=await runQuickMaintenance(slow,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
  const phase=report.phases.find(item=>item.phase==='extract')!;
  expect(delayed).toBe(true);
  expect(report.status,JSON.stringify(phase)).toBe('ok');
  expect(phase.details).toMatchObject({relationScopeRemaining:0,mentionScopeRemaining:0});
  expect(phase.details.relationCompletedSlugs).toHaveLength(slugs.length);
  const rows=await linkedPages(sourceId);
  expect(rows).toHaveLength(slugs.length);
  expect(rows.every(row=>row.targets===4)).toBe(true);
  expect(rows.some(row=>row.slug==='notes/unchanged-history')).toBe(false);
  expect((await engine.getPage('people/chen',{sourceId}))?.compiled_truth).toBe('已有实体的知识保持原样。');
},180000);

test('一份资料关联出错，其余资料完成；保存原始错误，修复后继续没有重复关联',async()=>{
  const sourceId='relation-failure';const {slugs,sync}=await fixture(sourceId,3);let broken=true;
  const faulty=new Proxy(engine,{get(target,key){
    if(key==='executeRaw')return async(sql:string,params?:unknown[])=>{if(broken&&sql.includes('s.incarnation::text AS incarnation')&&params?.[0]===slugs[1])throw new Error('隔离验收：此份资料无法读取');return target.executeRaw(sql,params);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const first=await runQuickMaintenance(faulty,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
  const failed=first.phases.find(item=>item.phase==='extract')!;
  expect(first.status).toBe('partial');
  expect(failed.details.relationFailures).toContainEqual({sourceId,slug:slugs[1],step:'显式关系',error:'隔离验收：此份资料无法读取'});
  expect(failed.details.relationCompletedSlugs).toEqual([slugs[0],slugs[2]]);
  expect((await linkedPages(sourceId)).filter(row=>row.slug!==slugs[1]).every(row=>row.targets===4)).toBe(true);
  broken=false;
  const next=await runQuickMaintenance(faulty,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
  expect(next.status,JSON.stringify(next)).toBe('ok');
  expect(next.phases.find(item=>item.phase==='extract')?.details.relationCompletedSlugs).toHaveLength(3);
  expect((await linkedPages(sourceId)).every(row=>row.targets===4)).toBe(true);
},120000);

test('关联期间资料发生变化，在同一轮继续处理到最终版本，不遗留无错误的待处理项',async()=>{
  const sourceId='relation-concurrent';const {slugs,sync}=await fixture(sourceId,1);let edits=0;
  const changing=new Proxy(engine,{get(target,key){
    if(key==='executeRaw')return async(sql:string,params?:unknown[])=>{
      const rows=await target.executeRaw(sql,params);
      if(edits<2&&sql.includes("p.frontmatter->'mention_ignore'")&&sql.includes('ORDER BY p.id LIMIT $4')&&Array.isArray(rows)&&rows.length){
        edits++;
        await target.putPage(slugs[0],{type:'note',title:slugs[0],compiled_truth:`陈明负责清河项目，远山团队和云海公司参与。参见 [[people/chen]]。版本${edits}`,timeline:'',frontmatter:{}},{sourceId});
      }
      return rows;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const report=await runQuickMaintenance(changing,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
  const phase=report.phases.find(item=>item.phase==='extract')!;
  expect(edits).toBe(2);expect(report.status,JSON.stringify(phase)).toBe('ok');
  expect(phase.details).toMatchObject({relationScopeRemaining:0,mentionScopeRemaining:0,remaining:0,relationCompletedSlugs:slugs,relationFailures:[]});
  expect((await linkedPages(sourceId))[0]?.targets).toBe(4);
},120000);

test('显式关系写入遇到资料版本变化时重新关联当前版本，不把并发变化记成永久失败',async()=>{
  const sourceId='relation-revision';const {slugs,sync}=await fixture(sourceId,1);let edited=false;
  const changing=new Proxy(engine,{get(target,key){
    if(key==='executeRaw')return async(sql:string,params?:unknown[])=>{
      const rows=await target.executeRaw(sql,params);
      if(!edited&&sql.includes('s.incarnation::text AS incarnation')&&params?.[0]===slugs[0]){
        edited=true;
        await target.putPage(slugs[0],{type:'note',title:slugs[0],compiled_truth:'陈明负责清河项目，远山团队和云海公司参与。参见 [[people/chen]]。更新后的正文。',timeline:'',frontmatter:{}},{sourceId});
      }
      return rows;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const report=await runQuickMaintenance(changing,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
  const phase=report.phases.find(item=>item.phase==='extract')!;
  expect(edited).toBe(true);expect(report.status,JSON.stringify(phase)).toBe('ok');
  expect(phase.details).toMatchObject({relationFailures:[],relationCompletedSlugs:slugs,remaining:0});
  expect((await linkedPages(sourceId))[0]?.targets).toBe(4);
},120000);

test('本轮四类实体关联完成后结束，原有概念关联不被改写且不会阻塞任务',async()=>{
  const sourceId='relation-owned-scope';const {slugs,sync}=await fixture(sourceId,1);
  await engine.putPage('concepts/legacy',{type:'concept',title:'原有概念',compiled_truth:'保留的概念知识。',timeline:'',frontmatter:{}},{sourceId});
  await engine.addLinksBatch([
    {from_slug:slugs[0],to_slug:'concepts/legacy',from_source_id:sourceId,to_source_id:sourceId,link_type:'mentions',link_source:'mentions'},
    {from_slug:slugs[0],to_slug:'concepts/legacy',from_source_id:sourceId,to_source_id:sourceId,link_type:'related',link_source:'mentions',link_kind:'typed_ner'},
  ]);
  const report=await runQuickMaintenance(engine,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract'],signal:AbortSignal.timeout(15000)});
  expect(report.status,JSON.stringify(report)).toBe('ok');
  expect(report.phases.find(item=>item.phase==='extract')?.details).toMatchObject({relationCompletedSlugs:slugs,remaining:0,relationFailures:[]});
  const rows=await engine.executeRaw<{n:number}>(`SELECT count(*)::int n FROM links l JOIN pages p ON p.id=l.to_page_id WHERE p.source_id=$1 AND p.slug='concepts/legacy'`,[sourceId]);
  expect(rows[0].n).toBe(2);
  expect((await linkedPages(sourceId))[0]?.targets).toBe(5);
},60000);

test('关联写入批次内一份失败仍提交其他资料，关系类型读取错误也保留到失败明细',async()=>{
  const sourceId='relation-write-failure';const {slugs,sync}=await fixture(sourceId,3);
  await engine.executeRaw(`CREATE FUNCTION reject_relation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.link_source='mentions' AND EXISTS(SELECT 1 FROM pages WHERE id=NEW.from_page_id AND source_id='relation-write-failure' AND slug='notes/item-1') THEN
      RAISE EXCEPTION '隔离验收：这份资料的关联写入被拒绝';
    END IF; RETURN NEW; END $$`);
  await engine.executeRaw('CREATE TRIGGER reject_relation_fixture BEFORE INSERT ON links FOR EACH ROW EXECUTE FUNCTION reject_relation_fixture()');
  const faulty=new Proxy(engine,{get(target,key){
    if(key==='getPage')return async(slug:string,options?:{sourceId?:string})=>{if(slug===slugs[1]&&options?.sourceId===sourceId)throw new Error('隔离验收：关系类型读取失败');return target.getPage(slug,options);};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try {
    const report=await runQuickMaintenance(faulty,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
    const phase=report.phases.find(item=>item.phase==='extract')!;
    expect(report.status).toBe('partial');
    expect(phase.details.relationFailures).toEqual(expect.arrayContaining([
      {sourceId,slug:slugs[1],step:'名称提及',error:'隔离验收：这份资料的关联写入被拒绝'},
      {sourceId,slug:slugs[1],step:'关系类型',error:'隔离验收：关系类型读取失败'},
    ]));
    expect(phase.details.relationCompletedSlugs).toEqual([slugs[0],slugs[2]]);
    expect((await linkedPages(sourceId)).filter(row=>row.slug!==slugs[1]).every(row=>row.targets===4)).toBe(true);
  }finally {await engine.executeRaw('DROP TRIGGER reject_relation_fixture ON links');await engine.executeRaw('DROP FUNCTION reject_relation_fixture()');}
},120000);

test('关联途中停止后保留已提交结果，继续时完成剩余资料且不重复写入',async()=>{
  const sourceId='relation-stop';const {slugs,sync}=await fixture(sourceId,26);
  const controller=new AbortController();let stopped=false;
  try {
    await runQuickMaintenance(engine,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract'],signal:controller.signal,
      yieldDuringPhase:async()=>{
        const rows=await linkedPages(sourceId);
        if(rows.length>0&&rows.length<slugs.length){stopped=true;controller.abort(new Error('隔离验收：停止关联'));}
      }});
  }catch(error){expect(String(error)).toContain('停止关联');}
  expect(stopped).toBe(true);
  expect((await linkedPages(sourceId)).length).toBeGreaterThan(0);
  const report=await runQuickMaintenance(engine,{brainDir:null,sourceId,completedPhases:[sync],phaseWindow:['extract']});
  expect(report.status,JSON.stringify(report)).toBe('ok');
  expect(report.phases.find(item=>item.phase==='extract')?.details.relationCompletedSlugs).toHaveLength(slugs.length);
  expect((await linkedPages(sourceId)).every(row=>row.targets===4)).toBe(true);
},120000);
