import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {hasDatabase,setupDB,teardownDB} from './helpers.ts';
import {PMBRAIN_MCP_INSTRUCTIONS} from '../../src/mcp/instructions.ts';

const enabled=hasDatabase();
const run=enabled?test:test.skip;
let child: ReturnType<typeof Bun.spawn>;
let home:string,base:string,cookie:string;
let childEnv:Record<string,string>;

async function request(path:string,body?:unknown){
  const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie??''},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await res.json();
  if(!res.ok)throw Error(`${path}: ${res.status} ${JSON.stringify(data)}`);
  return data as any;
}

beforeAll(async()=>{
  if(!enabled)return;
  await setupDB();
  home=mkdtempSync(join(tmpdir(),'pmbrain-wb-http-'));
  mkdirSync(join(home,'.pmbrain'),{recursive:true});
  writeFileSync(join(home,'.pmbrain','config.json'),JSON.stringify({engine:'postgres',database_url:process.env.DATABASE_URL,mcp_surface:'full'}));
  const port=await new Promise<number>(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const address=server.address() as {port:number};server.close(()=>resolve(address.port));});});
  base=`http://127.0.0.1:${port}`;
  childEnv={...process.env,PMBRAIN_HOME:home,GBRAIN_HOME:home,CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude'),PMBRAIN_DIAGNOSTIC_MODE:'1',PMBRAIN_ADMIN_BOOTSTRAP_TOKEN:'writeback-test-bootstrap-token-000000000',PMBRAIN_MCP_INSTRUCTIONS:'must-not-change-off-contract'} as Record<string,string>;
  child=Bun.spawn([process.execPath,resolve('src/cli.ts'),'serve','--http','--bind','127.0.0.1','--port',String(port),'--suppress-bootstrap-token'],{env:childEnv,stdout:'ignore',stderr:'pipe'});
  let stderr='';void new Response(child.stderr as ReadableStream<Uint8Array>).text().then(text=>{stderr=text;});
  let ready=false;
  for(let i=0;i<60;i++){try{const res=await fetch(base+'/health');if(res.ok){ready=true;break;}}catch{}await Bun.sleep(250);}
  if(!ready)throw Error('HTTP startup failed '+stderr.slice(-500));
  const auth=await fetch(base+'/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:childEnv.PMBRAIN_ADMIN_BOOTSTRAP_TOKEN})});
  expect(auth.ok).toBe(true);cookie=auth.headers.get('set-cookie')!.split(';')[0];
},60000);

afterAll(async()=>{
  if(!enabled)return;
  if(child){child.kill();await child.exited;}
  await teardownDB();
  if(home){
    if(process.platform==='win32')console.warn(`Windows socket 测试目录保留供诊断：${home}`);
    else rmSync(home,{recursive:true,force:true});
  }
},30000);

run('HTTP initialize 按实时配置和真实写权限发布合同；关闭拆托管块',async()=>{
  const readKey=await request('/admin/api/api-keys',{name:'writeback-read',scopes:'read'});
  const writeKey=await request('/admin/api/api-keys',{name:'writeback-write',scopes:'read write'});
  const initialize=async(token:string)=>{
    const res=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'writeback-test',version:'1'}}})});
    const text=await res.text();
    expect(res.ok).toBe(true);
    const data=JSON.parse(text.startsWith('event:')||text.startsWith('data:')?text.split('\n').find(line=>line.startsWith('data:'))!.slice(5):text);
    return data.result.instructions;
  };
  expect(await initialize(writeKey.token)).toBe(PMBRAIN_MCP_INSTRUCTIONS);
  const later=await request('/admin/api/memory/writeback',{notice_shown:true});
  expect(later.mode).toBe('off');expect(later.notice_shown).toBe(true);
  await request('/admin/api/memory/writeback',{mode:'salient',ttl:'12h'});
  expect(await initialize(readKey.token)).toBe(PMBRAIN_MCP_INSTRUCTIONS);
  expect(await initialize(writeKey.token)).toContain('mode: salient');
  await request('/admin/api/memory/writeback/agent',{agent:'codex',mcpConfirmed:true,serveUrl:base+'/mcp'});
  expect(readFileSync(join(home,'codex','AGENTS.md'),'utf8')).toContain('ttl: "12h"');
  await request('/admin/api/memory/writeback',{mode:'off'});
  expect(readFileSync(join(home,'codex','AGENTS.md'),'utf8')).not.toContain('ambient-writeback:begin');
  expect(await initialize(writeKey.token)).toBe(PMBRAIN_MCP_INSTRUCTIONS);
},60000);

run('stdio initialize 关闭字节一致，重启后读取新合同',async()=>{
  for(const mode of ['off','all'] as const){
    await request('/admin/api/memory/writeback',{mode});
    const client=new Client({name:'writeback-stdio-test',version:'1'},{capabilities:{}});
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'serve'],env:childEnv,stderr:'ignore'});
    try{await client.connect(transport);const instructions=client.getInstructions();if(mode==='off')expect(instructions).toBe(PMBRAIN_MCP_INSTRUCTIONS);else expect(instructions).toContain('mode: all');}
    finally{await client.close();}
  }
},60000);
