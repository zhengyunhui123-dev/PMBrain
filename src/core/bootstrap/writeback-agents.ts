import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { configDir } from '../config.ts';
import { isValidSourceId } from '../source-id.ts';
import { probeAmbientBlock, spliceAmbientWritebackBlock, removeAmbientWritebackBlock, renderAmbientInstructionBlock } from './instructions-block.ts';
import type { WritebackMode } from '../facts/writeback-config.ts';

type Agent = 'codex' | 'claude';
type Paths = { home?: string; codexHome?: string; claudeHome?: string };
type Settings = { mode: WritebackMode; ttl: string; visibility: 'world' | 'private' };
type Registration = { agent: Agent; sourceId: string; serveUrl: string; command: string };
const MARKER = 'PMBrain ambient writeback';
const CODEX_HOOK_MARKER = 'pmbrain hook session-end --harness codex';
const CODEX_TRUST_BEGIN = '# --- pmbrain:codex-writeback-trust begin ---';
const CODEX_TRUST_END = '# --- pmbrain:codex-writeback-trust end ---';

export function buildWritebackHookCommand(sourceId: string, subcommand: 'stop' | 'session-end' = 'stop'): string {
  if(!isValidSourceId(sourceId))throw new Error('非法 Source');
  const args=[process.execPath,process.argv[1],'hook',subcommand,'--config-dir',configDir(),'--source',sourceId];
  if(subcommand==='session-end')args.push('--harness','codex');
  if(args.some(a=>!a))throw new Error('无法定位 PMBrain CLI');
  if(process.platform==='win32'){
    if(subcommand==='session-end'){
      const script=`try { & ${args.map(a=>`'${a.replace(/'/g,"''")}'`).join(' ')} '--detached' } catch {}; exit 0 # ${CODEX_HOOK_MARKER}`;
      return `powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g,'`"')}"`;
    }
    const script=`try { & ${args.map(a=>`'${a.replace(/'/g,"''")}'`).join(' ')} } catch {}; exit 0`;
    return `powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g,'`"')}"`;
  }
  const command=`${args.map(a=>`'${a.replace(/'/g,"'\\''")}'`).join(' ')} || true`;
  return subcommand==='session-end'?`${command} # ${CODEX_HOOK_MARKER}`:command;
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

function claudeHookSettings(text: string | null, command?: string): string {
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

function canonicalJson(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

function codexTrustHash(command: string): string {
  return `sha256:${createHash('sha256').update(canonicalJson({event_name:'session_end',hooks:[{type:'command',command,timeout:3,async:false}]}),'utf8').digest('hex')}`;
}

function stripCodexTrustBlock(text: string): { text: string; eol: string } {
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const lines=text.replace(/\r\n/g,'\n').split('\n');
  const begin=lines.indexOf(CODEX_TRUST_BEGIN),end=lines.indexOf(CODEX_TRUST_END);
  if((begin<0)!==(end<0)||begin>end)throw new Error('Codex Hook 信任块标记损坏');
  const kept=begin>=0?[...lines.slice(0,begin),...lines.slice(end+1)]:lines;
  while(kept.length&&kept.at(-1)?.trim()==='')kept.pop();
  return {text:kept.join(eol),eol};
}

function codexHookSettings(
  hooksText: string | null,
  configText: string | null,
  hooksPath: string,
  command?: string,
): { hooks: string; config: string } {
  const doc=hooksText===null?{}:JSON.parse(hooksText);
  if(!doc||typeof doc!=='object'||Array.isArray(doc))throw new Error('Codex hooks.json 必须是对象');
  const hooks=doc.hooks??{};
  if(!hooks||typeof hooks!=='object'||Array.isArray(hooks))throw new Error('Codex hooks 配置格式无效');
  const current=hooks.SessionEnd??[];
  if(!Array.isArray(current))throw new Error('Codex SessionEnd 配置必须是数组');
  const owned=(entry:any)=>Array.isArray(entry?.hooks)&&entry.hooks.some((hook:any)=>typeof hook?.command==='string'&&hook.command.includes(CODEX_HOOK_MARKER));
  const existingIndex=current.findIndex(owned);
  const cleaned=current.filter((entry:any,index:number)=>index===existingIndex||!owned(entry));
  const group=command?{hooks:[{type:'command',command,timeout:3}]}:null;
  const next=group?(existingIndex>=0?cleaned.map((entry:any,index:number)=>index===existingIndex?group:entry):[...cleaned,group]):cleaned.filter((entry:any)=>!owned(entry));
  if(next.length)hooks.SessionEnd=next;else delete hooks.SessionEnd;
  if(Object.keys(hooks).length)doc.hooks=hooks;else delete doc.hooks;
  const stripped=stripCodexTrustBlock(configText??'');
  if(!command)return {hooks:JSON.stringify(doc,null,2)+'\n',config:stripped.text?`${stripped.text}${stripped.eol}`:''};
  const groupIndex=next.findIndex((entry:any)=>owned(entry));
  const trustKey=`${hooksPath}:session_end:${groupIndex}:0`;
  if(stripped.text.split(/\r?\n/).some(line=>line.includes('[hooks.state.')&&line.includes(trustKey)))throw new Error('Codex 配置已有同名 Hook 信任项，未覆盖');
  const block=[CODEX_TRUST_BEGIN,`[hooks.state.${JSON.stringify(trustKey)}]`,`trusted_hash = ${JSON.stringify(codexTrustHash(command))}`,CODEX_TRUST_END].join(stripped.eol);
  const prefix=stripped.text?`${stripped.text}${stripped.eol}${stripped.eol}`:'';
  return {hooks:JSON.stringify(doc,null,2)+'\n',config:`${prefix}${block}${stripped.eol}`};
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
      if(raw!==null||settings.mode!=='off')changes.set(file,claudeHookSettings(raw,settings.mode==='off'?undefined:row.command));
    }else{
      const hooksFile=join(paths.codexHome,'hooks.json');
      const configFile=join(paths.codexHome,'config.toml');
      const hooksRaw=readText(hooksFile),configRaw=readText(configFile);
      if(hooksRaw!==null||configRaw!==null||settings.mode!=='off'){
        const planned=codexHookSettings(hooksRaw,configRaw,hooksFile,settings.mode==='off'?undefined:row.command);
        changes.set(hooksFile,planned.hooks);
        changes.set(configFile,planned.config);
      }
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
      }else{
        const hooksText=readText(join(dir,'hooks.json'));
        const configText=readText(join(dir,'config.toml'))??'';
        const config=hooksText?JSON.parse(hooksText):{};
        const groups=Array.isArray(config.hooks?.SessionEnd)?config.hooks.SessionEnd:[];
        const groupIndex=groups.findIndex((entry:any)=>entry.hooks?.some((h:any)=>typeof h.command==='string'&&h.command.includes(CODEX_HOOK_MARKER)));
        const command=groupIndex>=0?groups[groupIndex].hooks.find((h:any)=>typeof h.command==='string'&&h.command.includes(CODEX_HOOK_MARKER))?.command:null;
        if(command){
          const trustKey=`${join(dir,'hooks.json')}:session_end:${groupIndex}:0`;
          hook=configText.includes(`[hooks.state.${JSON.stringify(trustKey)}]`)&&configText.includes(`trusted_hash = ${JSON.stringify(codexTrustHash(command))}`)?'installed':'untrusted';
        }else hook='absent';
      }
      return {agent,registered:registered.some(r=>r.agent===agent),block,hook,issue:override?'AGENTS.override.md 阻止托管指令生效':block==='damaged'?'托管标记损坏':hook==='untrusted'?'Codex SessionEnd Hook 未获得匹配的信任记录':null};
    }catch(e){return {agent,registered:registered.some(r=>r.agent===agent),block:'unknown',hook:'unknown',issue:e instanceof Error?e.message:String(e)};}
  });
}
