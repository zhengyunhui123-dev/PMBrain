import express from 'express';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {BrainEngine} from '../../src/core/engine';
import {WorkerPgliteEngine} from '../../src/product/database/worker-engine';
import {ProductTaskRuntime} from '../../src/product/tasks/runtime';
import {registerPmbrainAdminRoutes} from '../../src/commands/pmbrain-admin-routes';
import {idleBackground} from '../helpers/background-resources';

const root=mkdtempSync(join(tmpdir(),'pmbrain-maintenance-ui-'));
process.env.PMBRAIN_HOME=root;process.env.GBRAIN_HOME=root;
for(const key of ['DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'])delete process.env[key];
mkdirSync(join(root,'.pmbrain'));
const files=join(root,'materials');mkdirSync(files);
for(let index=0;index<12;index++)writeFileSync(join(files,`material-${index}.md`),`# 本轮验收资料 ${index}\n\n李明负责青山项目。\n\n${'这是隔离浏览器验收中的资料，不含真实用户内容。'.repeat(30)}`);
let modelCalls=0,vectorCalls=0;
const model=Bun.serve({port:0,async fetch(request){
  const body:any=await request.json();
  if(new URL(request.url).pathname.endsWith('/embeddings')){
    vectorCalls++;await Bun.sleep(100);
    return Response.json({object:'list',data:(Array.isArray(body.input)?body.input:[body.input]).map((_:unknown,index:number)=>({object:'embedding',index,embedding:Array.from({length:1024},(_,i)=>i===0?1:0)})),model:'ui-embedding',usage:{prompt_tokens:2,total_tokens:2}});
  }
  modelCalls++;return Response.json({error:{message:'本测试不允许生成模型请求'}},{status:500});
}});
const config:any={engine:'pglite',custom_openai_api_key:'isolated-ui-only',embedding_model:'custom-openai:ui-embedding',embedding_dimensions:1024,
  provider_base_urls:{'custom-openai':model.url.origin+'/v1'},model_usage:{generative_enabled:false,embedding_enabled:true},desktop:{theme:'light'}};
writeFileSync(join(root,'.pmbrain','config.json'),JSON.stringify(config));
const engine=new WorkerPgliteEngine() as unknown as BrainEngine;
await engine.connect({});await engine.initSchema();
await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'",[files]);
await engine.setConfig('sync.auto_git_commit','false');
await engine.putPage('people/li',{title:'李明',type:'person',compiled_truth:'# 李明\n\n已有人员。',frontmatter:{},timeline:''});
await engine.putPage('projects/qingshan',{title:'青山项目',type:'project',compiled_truth:'# 青山项目\n\n已有项目。',frontmatter:{},timeline:''});
const runtime=new ProductTaskRuntime(engine,{background:idleBackground});await runtime.start();
const app=express();app.use(express.json());
registerPmbrainAdminRoutes({app,engine,config,requireAdmin:(_req,_res,next)=>next(),getPgliteBusy:()=>false,ensureAdminWorkerStarted:async()=>{},productTasks:runtime});
app.get('/fixture',(_req,res)=>res.json({root,files,modelCalls,vectorCalls}));
app.post('/fixture/add-late',(_req,res)=>{writeFileSync(join(files,'arrived-later.md'),'# 下轮资料\n\n本轮不应导入。');res.json({ok:true});});
app.post('/fixture/ordinary',(_req,res)=>{
  const folder=join(root,'ordinary-import');mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'ordinary-good.md'),'# 普通导入成功资料\n\n这份资料应正常保存。');
  writeFileSync(join(folder,'ordinary-bad.md'),'---\nslug: wrong-ordinary\n---\n# 普通导入失败资料\n\n保留原始错误。');
  res.json({path:folder});
});
app.get('/fixture/pages',async(_req,res)=>res.json(await engine.executeRaw('SELECT slug,type FROM pages WHERE deleted_at IS NULL ORDER BY slug')));
app.post('/fixture/relations-failure',async(_req,res)=>{
  const folder=join(root,'relations-failure');mkdirSync(folder,{recursive:true});
  for(const name of ['first','blocked','last'])writeFileSync(join(folder,`${name}.md`),'# 隔离关联资料\n\n李明负责青山项目。');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('ui-relations-failure','关联失败验收',$1)",[folder]);
  await engine.executeRaw(`CREATE FUNCTION reject_ui_relation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id='ui-relations-failure' AND NEW.slug='blocked' AND NEW.links_extracted_at IS DISTINCT FROM OLD.links_extracted_at THEN
      RAISE EXCEPTION '隔离验收：blocked.md 关联保存失败';
    END IF; RETURN NEW; END $$`);
  await engine.executeRaw('CREATE TRIGGER reject_ui_relation BEFORE UPDATE OF links_extracted_at ON pages FOR EACH ROW EXECUTE FUNCTION reject_ui_relation()');
  res.json({sourceId:'ui-relations-failure'});
});
app.post('/fixture/relations-repair',async(_req,res)=>{
  await engine.executeRaw('DROP TRIGGER reject_ui_relation ON pages');await engine.executeRaw('DROP FUNCTION reject_ui_relation()');res.json({ok:true});
});
app.use('/admin',express.static(resolve('admin/dist')));
const server=app.listen(5398,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
console.log('MAINTENANCE_UI_READY http://127.0.0.1:5398/admin/');
const close=async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();await engine.disconnect();model.stop(true);process.exit(0);};
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
