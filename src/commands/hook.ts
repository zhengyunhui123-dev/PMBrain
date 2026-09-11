import { mkdirSync, openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { configDir } from '../core/config.ts';
import { gateWritebackTurn } from '../core/facts/writeback-gate.ts';
import { bankWritebackTurn } from '../core/facts/writeback-bank.ts';
import { resolveWritebackConfigFromFile } from '../core/facts/writeback-config.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { codexSessionUserTurns } from '../core/facts/writeback-codex.ts';

function writebackCorpusDir(home: string): string {
  const dir = join(home, 'writeback-corpus');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionSourceId(args: string[]): string | null {
  const index=args.indexOf('--source');
  const env = (index>=0 ? args[index+1] ?? '' : process.env.PMBRAIN_SOURCE || '').trim();
  return env && isValidSourceId(env) ? env : null;
}

async function readStdinJson(timeoutMs: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  const stdin = process.stdin;
  if (stdin.isTTY) return {};
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), timeoutMs);
    let size=0;
    stdin.on('data', (chunk) => { size+=Buffer.byteLength(chunk);if(size>65536){clearTimeout(timer);stdin.destroy();resolve({});return;}chunks.push(Buffer.from(chunk)); });
    stdin.on('end', () => {
      clearTimeout(timer);
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
      } catch {
        resolve({});
      }
    });
    stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

function detachedPayloadPath(args: string[], home: string): string | null {
  const index=args.indexOf('--payload-file');
  if(index<0||!args[index+1])return null;
  const path=resolve(args[index+1]);
  const root=resolve(join(home,'writeback-hook-payloads'));
  if(path!==root&&!path.startsWith(root.endsWith(sep)?root:`${root}${sep}`))return null;
  try {
    const stat=lstatSync(path);
    return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=65536?path:null;
  } catch { return null; }
}

async function detachSessionEnd(args: string[], home: string, payload: Record<string, unknown>): Promise<number> {
  const entry=process.argv[1];
  if(!entry)return 0;
  const dir=join(home,'writeback-hook-payloads');
  mkdirSync(dir,{recursive:true});
  const file=join(dir,`${randomUUID()}.json`);
  writeFileSync(file,JSON.stringify(payload),{encoding:'utf8',mode:0o600});
  try {
    const child=spawn(process.execPath,[entry,'hook',...args,'--detached','--payload-file',file],{
      cwd:process.cwd(),env:process.env,detached:true,stdio:'ignore',windowsHide:true,
    });
    child.unref();
  } catch {
    unlinkSync(file);
  }
  return 0;
}

export function lastUserText(payload: Record<string, unknown>): string {
  if(payload.stop_hook_active === true || payload.hook_event_name !== 'Stop')return '';
  if(typeof payload.transcript_path !== 'string' || typeof payload.session_id !== 'string')return '';
  const fd=openSync(payload.transcript_path,'r');
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile())return '';
    const length=Math.min(stat.size,256*1024);
    const buffer=Buffer.alloc(length);
    readSync(fd,buffer,0,length,stat.size-length);
    const lines=buffer.toString('utf8').split('\n');
    if(stat.size>length)lines.shift();
    for(const line of lines.reverse()){
      if(!line.trim())continue;
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(row.type!=='user'||row.isMeta||row.sessionId!==payload.session_id)continue;
      const content=row.message?.content;
      if(typeof content==='string')return content;
      if(!Array.isArray(content))return '';
      if(content.some((item:any)=>item.type==='tool_result'))continue;
      return content.filter((item:any)=>item.type==='text'&&typeof item.text==='string').map((item:any)=>item.text).join('\n');
    }
    return '';
  } finally {closeSync(fd);}
}

export async function runHook(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  let payloadFile: string | null = null;
  try {
    if (sub !== 'stop' && sub !== 'session-end') return 0;
    const homeIndex=args.indexOf('--config-dir');
    const home=homeIndex>=0 ? args[homeIndex+1] : configDir();
    if(!home)return 0;
    if(sub==='session-end'&&!args.includes('--detached'))return detachSessionEnd(args,home,await readStdinJson(300));
    payloadFile=detachedPayloadPath(args,home);
    const payload=payloadFile
      ? JSON.parse(readFileSync(payloadFile,'utf8')) as Record<string,unknown>
      : await readStdinJson(300);
    const wb = resolveWritebackConfigFromFile(JSON.parse(readFileSync(join(home,'config.json'),'utf8')));
    if (!wb.enabled) return 0;
    const codex = sub === 'session-end' && args.includes('--harness') && args[args.indexOf('--harness') + 1] === 'codex'
      ? codexSessionUserTurns(payload)
      : null;
    const sessionId = codex?.sessionId ?? (typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id.trim() : 'unknown');
    if (sessionId === 'unknown') return 0;
    const turns = codex?.turns ?? [lastUserText(payload)];
    for (const turn of turns) {
      const gated = gateWritebackTurn(turn);
      if (!gated.ok) continue;
      bankWritebackTurn({
        dir: writebackCorpusDir(home),
        sessionId,
        normalizedTurn: gated.normalized,
        hash24: gated.hash24,
        sourceId: sessionSourceId(args),
      });
    }
    return 0;
  } catch {
    return 0;
  } finally { if(payloadFile)try{unlinkSync(payloadFile);}catch{} }
}
