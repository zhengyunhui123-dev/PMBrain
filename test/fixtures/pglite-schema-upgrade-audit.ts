import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const root=resolve(process.argv[2]??'');
const mode=process.argv[3];
const moduleRoot=resolve(process.argv[4]??'');
if(!root.startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('pmbrain-schema-patch-audit-')||!moduleRoot.startsWith(resolve(tmpdir())+sep)||!['prepare','upgrade','verify'].includes(mode??''))throw new Error('invalid isolated schema upgrade audit');
process.env.PMBRAIN_HOME=root;
process.env.GBRAIN_HOME=root;
process.env.PMBRAIN_PGLITE_WAL_REPAIR='off';
for(const key of ['DATABASE_URL','PMBRAIN_DATABASE_URL','GBRAIN_DATABASE_URL'])delete process.env[key];
mkdirSync(join(root,'.pmbrain'),{recursive:true});
writeFileSync(join(root,'.pmbrain','config.json'),JSON.stringify({engine:'pglite'}));
configureGateway({embedding_model:'ollama:synthetic',embedding_dimensions:3,env:{}});
const path=join(root,'brain.pglite');
const sql="SELECT p.slug,p.compiled_truth,c.chunk_text,c.embedding::text AS embedding,c.model FROM pages p JOIN content_chunks c ON c.page_id=p.id WHERE p.slug='notes/legacy'";
if(mode==='upgrade'){
  const dir=join(moduleRoot,'node_modules','@electric-sql','pglite','dist');
  const {PGlite}=await import(pathToFileURL(join(dir,'index.js')).href);
  const {vector}=await import(pathToFileURL(join(dir,'vector','index.js')).href);
  const {pg_trgm}=await import(pathToFileURL(join(dir,'contrib','pg_trgm.js')).href);
  const db=await PGlite.create({dataDir:path,extensions:{vector,pg_trgm}});
  const rows=await db.query(sql);
  const links=await db.query('SELECT count(*)::int AS n FROM links');
  const trigram=await db.query("SELECT similarity('synthetic legacy','synthetic legacy') AS score");
  const config=await db.query("SELECT value FROM config WHERE key='compatibility.audit'");
  await db.query("INSERT INTO config (key,value) VALUES ('compatibility.patch','retained')");
  await db.query('CHECKPOINT');
  await db.close();
  console.log(JSON.stringify({event:mode,rows:rows.rows,links:links.rows,config:config.rows,trigram:trigram.rows}));
}else{
  const engine=new PGLiteEngine();
  await engine.connect({database_path:path});
  if(mode==='prepare'){
    await engine.initSchema();
    await engine.putPage('notes/legacy',{type:'note',title:'Legacy',compiled_truth:'synthetic retained body'});
    await engine.putPage('notes/target',{type:'note',title:'Target',compiled_truth:'synthetic target'});
    await engine.upsertChunks('notes/legacy',[{chunk_index:0,chunk_text:'synthetic retained chunk',chunk_source:'compiled_truth',embedding:new Float32Array([0.1,0.2,0.3]),model:'ollama:synthetic'}]);
    await engine.addLink('notes/legacy','notes/target','synthetic relation','mentions');
    await engine.setConfig('compatibility.audit','retained');
  }
  if(mode==='verify')await engine.initSchema();
  const rows=await engine.executeRaw(sql);
  const links=await engine.executeRaw('SELECT count(*)::int AS n FROM links');
  const config=await engine.getConfig('compatibility.audit');
  const patch=await engine.getConfig('compatibility.patch');
  await engine.disconnect();
  console.log(JSON.stringify({event:mode,rows,links,config,patch}));
}
