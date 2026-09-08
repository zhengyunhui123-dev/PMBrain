import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAmbientWritebackSection } from '../facts/writeback-instructions.ts';

export const AMBIENT_WRITEBACK_BLOCK_BEGIN = '<!-- pmbrain:ambient-writeback:begin -->';
export const AMBIENT_WRITEBACK_BLOCK_END = '<!-- pmbrain:ambient-writeback:end -->';

function damagedMarkersError(begins: number, ends: number): Error {
  return new Error(
    `the pmbrain ambient-writeback markers in this file are damaged ` +
      `(${begins} begin / ${ends} end` +
      `${begins === 1 && ends === 1 ? ', out of order' : ''}) — ` +
      `fix the markers or delete the whole block, then re-run deep integration.`,
  );
}

function scanMarkers(lines: string[]): { begin: number; end: number } | 'absent' {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line.replace(/\r$/, '') === AMBIENT_WRITEBACK_BLOCK_BEGIN) begins.push(i);
    if (line.replace(/\r$/, '') === AMBIENT_WRITEBACK_BLOCK_END) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return 'absent';
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) {
    throw damagedMarkersError(begins.length, ends.length);
  }
  return { begin: begins[0], end: ends[0] };
}

export function probeAmbientBlock(
  text: string,
): { state: 'absent' | 'present' | 'damaged'; interior?: string } {
  const lines = text.split('\n');
  try {
    const scan = scanMarkers(lines);
    if (scan === 'absent') return { state: 'absent' };
    return { state: 'present', interior: lines.slice(scan.begin + 1, scan.end).join('\n') };
  } catch {
    return { state: 'damaged' };
  }
}

export function spliceAmbientWritebackBlock(existing: string, body: string): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const scan = scanMarkers(lines);
  const neutralized = body
    .split('\n')
    .map((l) => (l.replace(/\r$/, '') === AMBIENT_WRITEBACK_BLOCK_BEGIN || l.replace(/\r$/, '') === AMBIENT_WRITEBACK_BLOCK_END ? ` ${l}` : l))
    .join('\n');
  const interior = neutralized.endsWith('\n') ? neutralized.slice(0, -1) : neutralized;
  if (scan === 'absent') {
    const head =
      existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    return `${head}${AMBIENT_WRITEBACK_BLOCK_BEGIN}${eol}${interior.replace(/\r?\n/g, eol)}${eol}${AMBIENT_WRITEBACK_BLOCK_END}${eol}`;
  }
  const out = [...lines.slice(0, scan.begin + 1), ...interior.split('\n'), ...lines.slice(scan.end)];
  const joined = out.join(eol);
  return joined.endsWith('\n') ? joined : `${joined}${eol}`;
}

export function removeAmbientWritebackBlock(existing: string): { text: string; removed: boolean } {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const scan = scanMarkers(lines);
  if (scan === 'absent') return { text: existing, removed: false };
  let after = scan.end + 1;
  if (after < lines.length - 1 && lines[after] === '') after++;
  const out = [...lines.slice(0, scan.begin), ...lines.slice(after)];
  return { text: out.join(eol), removed: true };
}

export function ambientBlockPresent(text: string): boolean {
  return text
    .split('\n')
    .some((l) => l.replace(/\r$/, '') === AMBIENT_WRITEBACK_BLOCK_BEGIN || l.replace(/\r$/, '') === AMBIENT_WRITEBACK_BLOCK_END);
}

export interface AmbientInstructionBlockOpts {
  mode: 'salient' | 'all';
  transientTtl: string;
  visibility: 'world' | 'private';
  serveUrl: string;
}

export function renderAmbientInstructionBlock(opts: AmbientInstructionBlockOpts): string {
  const header =
    `<!-- managed by PMBrain — mode: ${opts.mode}; serve: ${opts.serveUrl}; ` +
    `re-run after config changes; do not hand-edit inside markers -->`;
  const section = buildAmbientWritebackSection({
    mode: opts.mode,
    transientTtl: opts.transientTtl,
    visibility: opts.visibility,
    extractFactsAvailable: 'unknown',
  });
  return `${header}\n${section}`;
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: 'utf8' });
}

export function installAmbientWritebackBlockAt(path: string, body: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  atomicWrite(path, spliceAmbientWritebackBlock(existing, body));
}

export function removeAmbientWritebackBlockAt(path: string): { removed: boolean } {
  if (!existsSync(path)) return { removed: false };
  const existing = readFileSync(path, 'utf8');
  const { text, removed } = removeAmbientWritebackBlock(existing);
  if (removed) atomicWrite(path, text);
  return { removed };
}
