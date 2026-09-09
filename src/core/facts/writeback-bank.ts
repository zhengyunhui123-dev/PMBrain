import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidSourceId } from '../source-id.ts';

export function writebackFileName(sessionId: string, hash24: string, sourceId: string): string {
  return `${sessionId}.wb-${hash24}.src-${sourceId}.txt`;
}

export function parseWritebackSourceId(fileName: string): string | null {
  const match = fileName.match(/\.src-([a-z0-9-]{1,32})\.txt$/);
  const sourceId = match?.[1] ?? null;
  if (!sourceId || !isValidSourceId(sourceId)) return null;
  return sourceId;
}

export function bankWritebackTurn(opts: {
  dir: string;
  sessionId: string;
  normalizedTurn: string;
  hash24: string;
  sourceId: string | null | undefined;
}): { status: 'wb_banked' | 'wb_dup' | 'wb_no_source' | 'wb_empty'; fileName?: string } {
  const sourceId = opts.sourceId?.trim() ?? '';
  if (!sourceId || !isValidSourceId(sourceId)) return { status: 'wb_no_source' };
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(opts.sessionId)||!/^[a-f0-9]{24}$/.test(opts.hash24))return {status:'wb_empty'};
  const text = opts.normalizedTurn.trim();
  if (!text) return { status: 'wb_empty' };
  mkdirSync(opts.dir, { recursive: true });
  const fileName = writebackFileName(opts.sessionId, opts.hash24, sourceId);
  const file = join(opts.dir, fileName);
  if (existsSync(file)) return { status: 'wb_dup', fileName };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text + '\n', { encoding: 'utf8',mode:0o600 });
  renameSync(tmp, file);
  return { status: 'wb_banked', fileName };
}
