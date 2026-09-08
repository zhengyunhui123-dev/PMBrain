import { mkdirSync, openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../core/config.ts';
import { gateWritebackTurn } from '../core/facts/writeback-gate.ts';
import { bankWritebackTurn } from '../core/facts/writeback-bank.ts';
import { resolveWritebackConfigFromFile } from '../core/facts/writeback-config.ts';
import { isValidSourceId } from '../core/source-id.ts';

function writebackCorpusDir(home: string): string {
  const dir = join(home, 'writeback-corpus');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionSourceId(args: string[]): string | null {
  const index=args.indexOf('--source');
  const env = (index>=0 ? args[index+1] ?? '' : process.env.PMBRAIN_SOURCE || process.env.GBRAIN_SOURCE || '').trim();
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
  try {
    if (sub !== 'stop') return 0;
    const homeIndex=args.indexOf('--config-dir');
    const home=homeIndex>=0 ? args[homeIndex+1] : configDir();
    if(!home)return 0;
    const payload = await readStdinJson(300);
    const wb = resolveWritebackConfigFromFile(JSON.parse(readFileSync(join(home,'config.json'),'utf8')));
    if (!wb.enabled) return 0;
    const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : 'unknown';
    if (sessionId === 'unknown') return 0;
    const gated = gateWritebackTurn(lastUserText(payload));
    if (!gated.ok) return 0;
    bankWritebackTurn({
      dir: writebackCorpusDir(home),
      sessionId,
      normalizedTurn: gated.normalized,
      hash24: gated.hash24,
      sourceId: sessionSourceId(args),
    });
    return 0;
  } catch {
    return 0;
  }
}
