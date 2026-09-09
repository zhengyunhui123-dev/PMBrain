import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { createHash } from 'crypto';
import { redactSecretsInText } from './minions/handlers/shell-redact.ts';

export interface SecretFinding {

  pattern: string;

  line: number;

  redactedPreview: string;

  fingerprint: string;

  file?: string;
}

export interface ScanOpts {

  allowlist?: string[];

  workspaceRoot?: string;

  highEntropy?: boolean;
}

export const SCAN_ALLOW_FILENAME = '.gbrain-scan-allow';

interface CompiledPattern {
  name: string;
  re: RegExp;

  entropyGated?: boolean;
}

const CORE_PATTERNS: ReadonlyArray<{ name: string; source: string }> = [
  { name: 'anthropic', source: 'sk-ant-[A-Za-z0-9_-]{16,}' },

  { name: 'openai', source: 'sk-(?:proj|svcacct|None)-[A-Za-z0-9_-]{20,}' },
  { name: 'openai', source: 'sk-[A-Za-z0-9]{20,}' },

  { name: 'voyage', source: 'pa-[A-Za-z0-9_-]{20,}' },
  { name: 'github_pat', source: 'github_pat_[A-Za-z0-9_]{22,}' },
  { name: 'github_token', source: 'gh[pousr]_[A-Za-z0-9]{36,}' },
  { name: 'slack', source: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  { name: 'aws_access_key', source: 'AKIA[0-9A-Z]{16}' },

  { name: 'gbrain_token', source: 'gbrain_(?:at_|rt_|cs_|code_)?[0-9a-f]{64}' },

];

export const PEM_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g;

const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;

function compilePatterns(opts: ScanOpts): CompiledPattern[] {
  const out: CompiledPattern[] = CORE_PATTERNS.map((p) => ({
    name: p.name,
    re: new RegExp(`(^|[^A-Za-z0-9_])(${p.source})`, 'g'),
  }));
  if (opts.highEntropy) {

    out.push({
      name: 'high_entropy_assignment',
      re: new RegExp(
        `((?:^|[^A-Za-z0-9])(?:secret|token|passwd|password|passphrase|credential|api[_-]?key|apikey)[A-Za-z0-9_-]*["']?\\s*[:=]\\s*["']?)([A-Za-z0-9+/_=-]{12,})`,
        'gi',
      ),
      entropyGated: true,
    });
  }
  return out;
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function loadWorkspaceAllowlist(workspaceRoot: string): string[] {
  try {
    const p = join(workspaceRoot, SCAN_ALLOW_FILENAME);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;
  let g = glob;
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  GLOB_REGEX_CACHE.set(glob, compiled);
  return compiled;
}

export function matchesGlob(glob: string, relPath: string): boolean {
  const norm = relPath.split(sep).join('/');
  if (!glob.includes('/')) {
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    return globToRegExp(glob).test(base);
  }
  return globToRegExp(glob).test(norm);
}

function isFingerprintEntry(entry: string): boolean {
  return entry.startsWith('sha256:');
}

export const ALLOWLIST_FINGERPRINT_MIN_HEX = 16;

export function valueAllowlisted(fullHex: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (!isFingerprintEntry(entry)) continue;
    const prefix = entry.slice('sha256:'.length).toLowerCase();
    if (prefix.length >= ALLOWLIST_FINGERPRINT_MIN_HEX && fullHex.startsWith(prefix)) return true;
  }
  return false;
}

export function pathAllowlisted(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => !isFingerprintEntry(entry) && matchesGlob(entry, relPath));
}

interface RawHit {
  pattern: string;
  line: number;
  value: string;
  lineText: string;
}

function scanPemBlocks(text: string): RawHit[] {
  const hits: RawHit[] = [];
  PEM_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PEM_BLOCK_RE.exec(text)) !== null) {
    const value = m[0];
    if (value.length === 0) {
      PEM_BLOCK_RE.lastIndex++;
      continue;
    }

    const line = text.slice(0, m.index).split('\n').length;
    hits.push({ pattern: 'private_key_pem', line, value, lineText: value });
  }
  return hits;
}

function scanInternal(text: string, opts: ScanOpts): RawHit[] {
  const patterns = compilePatterns(opts);

  const hits: RawHit[] = scanPemBlocks(text);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 8) continue;
    const claimed: Array<[number, number]> = [];
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(line)) !== null) {
        const value = m[2];
        const start = m.index + m[1].length;
        const end = start + value.length;

        if (m[0].length === 0) p.re.lastIndex++;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        if (p.entropyGated && shannonEntropy(value) < HIGH_ENTROPY_MIN_BITS_PER_CHAR) continue;
        claimed.push([start, end]);
        hits.push({ pattern: p.name, line: i + 1, value, lineText: line });
      }
    }
  }
  return hits;
}

const PREVIEW_MAX_CHARS = 160;

function buildPreview(lineText: string, value: string, patternName: string): string {

  const redacted = redactSecretsInText(lineText, new Map([[patternName, value]])).trim();
  if (redacted.length <= PREVIEW_MAX_CHARS) return redacted;
  const at = redacted.indexOf(`<REDACTED:${patternName}>`);
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + redacted.slice(start, start + PREVIEW_MAX_CHARS) + '…';
}

function toFinding(hit: RawHit, file?: string): SecretFinding {
  const fullHex = createHash('sha256').update(hit.value).digest('hex');
  return {
    pattern: hit.pattern,
    line: hit.line,
    redactedPreview: buildPreview(hit.lineText, hit.value, hit.pattern),
    fingerprint: `sha256:${fullHex.slice(0, 16)}`,
    ...(file !== undefined ? { file } : {}),
  };
}

export function scanText(text: string, opts: ScanOpts = {}): SecretFinding[] {
  const allowlist = opts.allowlist ?? [];
  const out: SecretFinding[] = [];
  for (const hit of scanInternal(text, opts)) {
    const fullHex = createHash('sha256').update(hit.value).digest('hex');
    if (valueAllowlisted(fullHex, allowlist)) continue;
    out.push(toFinding(hit));
  }
  return out;
}

export const BINARY_SNIFF_BYTES = 8192;

export const SCAN_MAX_FILE_BYTES = 25 * 1024 * 1024;

export function looksBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function looksBinary(path: string): boolean {
  try {

    return looksBinaryBuffer(readFileSync(path));
  } catch {
    return true;
  }
}

export function scanFiles(paths: string[], opts: ScanOpts = {}): SecretFinding[] {
  const allowlist = opts.allowlist ?? [];
  const out: SecretFinding[] = [];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!st.isFile() || st.size > SCAN_MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    const rel =
      opts.workspaceRoot && isAbsolute(p) ? relative(opts.workspaceRoot, p) : p;
    if (pathAllowlisted(rel, allowlist)) continue;
    if (looksBinary(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    for (const f of scanText(text, opts)) {
      out.push({ ...f, file: p });
    }
  }
  return out;
}

export function redactFindings(
  text: string,
  opts: ScanOpts = {},
): { text: string; redactions: SecretFinding[] } {
  const allowlist = opts.allowlist ?? [];
  const redactions: SecretFinding[] = [];
  const seen = new Set<string>();
  let out = text;
  for (const hit of scanInternal(text, opts)) {
    const fullHex = createHash('sha256').update(hit.value).digest('hex');
    if (valueAllowlisted(fullHex, allowlist)) continue;
    redactions.push(toFinding(hit));
    const key = `${hit.pattern}\0${hit.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out = redactSecretsInText(out, new Map([[hit.pattern, hit.value]]));
  }
  return { text: out, redactions };
}
