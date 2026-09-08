import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { configDir } from '../config.ts';
import { isValidSourceId } from '../source-id.ts';
import { probeAmbientBlock, spliceAmbientWritebackBlock, removeAmbientWritebackBlock, renderAmbientInstructionBlock } from './instructions-block.ts';
import type { WritebackMode } from '../facts/writeback-config.ts';

type Agent = 'codex' | 'claude';
type Paths = { home?: string; codexHome?: string; claudeHome?: string };
type Settings = { mode: WritebackMode; ttl: string; visibility: 'world' | 'private' };
type Registration = { agent: Agent; sourceId: string; serveUrl: string; command: string };
const MARKER = 'PMBrain ambient writeback';

export function buildWritebackHookCommand(sourceId: string): string {
  if(!isValidSourceId(sourceId))throw new Error('非法 Source');
  const args=[process.execPath,process.argv[1],'hook','stop','--config-dir',configDir(),'--source',sourceId];
  if(args.some(a=>!a))throw new Error('无法定位 PMBrain CLI');
  if(process.platform==='win32'){
    const script=`try { & ${args.map(a=>`'${a.replace(/'/g,"''")}'`).join(' ')} } catch {}\nexit 0`;
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script,'utf16le').toString('base64')}`;
  }
  return `${args.map(a=>`'${a.replace(/'/g,"'\\''")}'`).join(' ')} || true`;
}

export function writebackAgentPaths(opts: Paths = {}) {
  return { home: opts.home ?? configDir(), codexHome: opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(),'.codex'), claudeHome: opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),'.claude') };
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error(`不能修改链接文件：${path}`);
  return readFileSync(path,'utf8');
}

function write(path: string, text: string) {
  mkdirSync(dirname(path),{recursive:true});
  const temp = `${path}.pmbrain-${process.pid}.tmp`;
  try { writeFileSync(temp,text,{mode:0o600}); renameSync(temp,path); }
  finally { if(existsSync(temp)) unlinkSync(temp); }
}

function registrations(home: string): Registration[] {
  const text=readText(join(home,'writeback-agents.json'));
  if(!text)return [];
  const rows: unknown=JSON.parse(text);
  if(!Array.isArray(rows)||rows.some(r=>!r||!['codex','claude'].includes(r.agent)||!isValidSourceId(r.sourceId)||typeof r.serveUrl!=='string'||typeof r.command!=='string'))throw new Error('长期记忆接入记录损坏');
  return rows;
}

function hookSettings(text: string | null, command?: string): string {
  const obj=text===null?{}:JSON.parse(text);
  if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error('Claude settings.json 必须是对象');
  const hooks=obj.hooks??{};
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks))throw new Error('Claude hooks 配置格式无效');
  const stop=hooks.Stop??[];
  if(!Array.isArray(stop))throw new Error('Claude Stop 配置必须是数组');
  const next=stop.map((entry:any)=>{
    if(!Array.isArray(entry.hooks))throw new Error('Claude Stop hooks 格式无效');
    return {...entry,hooks:entry.hooks.filter((h:any)=>h?.statusMessage!==MARKER)};
  }).filter((entry:any)=>entry.hooks.length);
  if(command)next.push({hooks:[{type:'command',command,timeout:10,statusMessage:MARKER}]});
  if(next.length)hooks.Stop=next;else delete hooks.Stop;
  if(Object.keys(hooks).length)obj.hooks=hooks;else delete obj.hooks;
  return JSON.stringify(obj,null,2)+'\n';
}

export function installWritebackAgent(opts: Paths & Settings & Registration & { mcpConfirmed: boolean }): void {
  if(!opts.mcpConfirmed)throw new Error('MCP 接入尚未确认成功');
  if(!isValidSourceId(opts.sourceId))throw new Error('缺少合法的知识 Source');
  const paths=writebackAgentPaths(opts);
  if(opts.agent==='codex'&&existsSync(join(paths.codexHome,'AGENTS.override.md')))throw new Error('存在 AGENTS.override.md，Codex 会忽略 AGENTS.md，请先处理该覆盖文件');
  const rows=registrations(paths.home).filter(r=>r.agent!==opts.agent);
  rows.push({agent:opts.agent,sourceId:opts.sourceId,serveUrl:opts.serveUrl,command:opts.command});
  apply(paths,rows,opts);
}

function apply(paths: ReturnType<typeof writebackAgentPaths>, rows: Registration[], settings: Settings, retained = rows) {
  const changes=new Map<string,string>();
  for(const row of rows){
    const path=join(row.agent==='codex'?paths.codexHome:paths.claudeHome,row.agent==='codex'?'AGENTS.md':'CLAUDE.md');
    const before=readText(path);
    if(settings.mode!=='off'&&row.agent==='codex'&&existsSync(join(paths.codexHome,'AGENTS.override.md')))throw new Error('AGENTS.override.md 阻止托管指令生效');
    const after=settings.mode==='off'?removeAmbientWritebackBlock(before??'').text:spliceAmbientWritebackBlock(before??'',renderAmbientInstructionBlock({mode:settings.mode,transientTtl:settings.ttl,visibility:settings.visibility,serveUrl:row.serveUrl}));
    if(after!==before&&(before!==null||after))changes.set(path,after);
    if(row.agent==='claude'){
      const file=join(paths.claudeHome,'settings.json');
      const raw=readText(file);
      if(raw!==null||settings.mode!=='off')changes.set(file,hookSettings(raw,settings.mode==='off'?undefined:row.command));
    }
  }
  changes.set(join(paths.home,'writeback-agents.json'),JSON.stringify(retained,null,2)+'\n');
  const originals=new Map([...changes.keys()].map(p=>[p,readText(p)]));
  const written:string[]=[];
  try { for(const [p,text] of changes){write(p,text);written.push(p);} }
  catch(error){for(const p of written.reverse()){const original=originals.get(p);if(original!=null)write(p,original);else if(existsSync(p))unlinkSync(p);}throw error;}
}

export function reconcileWritebackAgents(opts: Paths & Settings): void {
  const paths=writebackAgentPaths(opts);
  const rows=registrations(paths.home);
  if(rows.length)apply(paths,rows,opts);
}

export function removeWritebackAgent(opts: Paths & {agent: Agent}): void {
  const paths=writebackAgentPaths(opts);
  const rows=registrations(paths.home);
  apply(paths,rows.filter(r=>r.agent===opts.agent),{mode:'off',ttl:'3d',visibility:'private'},rows.filter(r=>r.agent!==opts.agent));
}

export function inspectWritebackAgents(opts: Paths = {}) {
  const paths=writebackAgentPaths(opts);
  const registered=registrations(paths.home);
  return (['codex','claude'] as const).map(agent=>{
    const dir=agent==='codex'?paths.codexHome:paths.claudeHome;
    const path=join(dir,agent==='codex'?'AGENTS.md':'CLAUDE.md');
    try {
      const block=probeAmbientBlock(readText(path)??'').state;
      const override=agent==='codex'&&existsSync(join(dir,'AGENTS.override.md'));
      let hook='not-applicable';
      if(agent==='claude'){
        const text=readText(join(dir,'settings.json'));
        const config=text?JSON.parse(text):{};
        hook=(config.hooks?.Stop??[]).some((entry:any)=>entry.hooks?.some((h:any)=>h.statusMessage===MARKER))?'installed':'absent';
      }
      return {agent,registered:registered.some(r=>r.agent===agent),block,hook,issue:override?'AGENTS.override.md 阻止托管指令生效':block==='damaged'?'托管标记损坏':null};
    }catch(e){return {agent,registered:registered.some(r=>r.agent===agent),block:'unknown',hook:'unknown',issue:e instanceof Error?e.message:String(e)};}
  });
}
