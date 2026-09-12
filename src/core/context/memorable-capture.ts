import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, loadConfig } from '../config.ts';
import { captureSpecFor } from '../transcripts/capture-spec.ts';
import { toCorpusText } from '../transcripts/claude-code-jsonl.ts';
import { mapOpenclawLine } from '../transcripts/openclaw.ts';
import {
  memorableGateAllowed,
  recordAndRelayReceipt,
  redactedToolCallsJson,
  type RelayReceiptResult,
  type SessionReceiptEntry,
} from './hook-heartbeat.ts';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

export function sanitizeSessionId(id: unknown): string {
  const s =
    typeof id === 'string' ? id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 120) : '';
  return s && !/^\.+$/.test(s) ? s : 'unknown';
}

function ensureDir0700(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  return dir;
}

function corpusDir(): string {
  const home = configDir();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'corpus'));
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function harnessOf(raw: string | undefined): SessionReceiptEntry['harness'] {
  if (raw === 'codex' || raw === 'openclaw' || raw === 'opencode') return raw;
  return 'claude-code';
}

export async function captureAndRelaySessionEnd(opts: {
  payload: Record<string, unknown>;
  harness?: string;
  cwd?: string;
  spawnFn?: typeof spawn;
  transcriptRoot?: string;
}): Promise<RelayReceiptResult> {
  const cfg = loadConfig();
  const memorableAllowed = (await memorableGateAllowed(cfg)).allowed;
  if (!memorableAllowed) return { recorded: false, degradeReasons: [] };
  const spec = captureSpecFor(opts.harness);
  const rootOpt = opts.transcriptRoot ? { root: opts.transcriptRoot } : {};
  let conf = spec.confine(opts.payload.transcript_path, { ...rootOpt });
  let discoveryWasGuess = false;
  let sessionId = sanitizeSessionId(opts.payload.session_id);
  if (!conf.ok && conf.reason === 'missing_path' && spec.discover) {
    const found = spec.discover(sessionId === 'unknown' ? null : sessionId, { ...rootOpt });
    if (found) {
      discoveryWasGuess = found.degrade === 'transcript_discovered_newest';
      conf = spec.confine(found.path, { ...rootOpt });
    }
  }
  if (!conf.ok) return { recorded: false, degradeReasons: [`transcript_${conf.reason}`] };
  const parsed = spec.parse(conf.path, { collectToolCalls: memorableAllowed });
  if (sessionId === 'unknown') {
    const inline = (parsed as { sessionId?: string | null }).sessionId;
    if (typeof inline === 'string' && inline) sessionId = sanitizeSessionId(inline);
  }
  if (parsed.bytesRead > 0 && parsed.turns.length === 0) {
    return { recorded: false, degradeReasons: ['parser_drift'] };
  }
  if (parsed.turns.length === 0) return { recorded: false, degradeReasons: [] };
  let text = toCorpusText(parsed.turns);
  let toolCallsJson = '[]';
  let redactionsN: number | undefined;
  try {
    const scan = await import('../secret-scan.ts');
    const redacted = scan.redactFindings(text, memorableAllowed ? { highEntropy: true } : {});
    text = redacted.text;
    redactionsN = redacted.redactions.length;
    if (memorableAllowed) {
      toolCallsJson = await redactedToolCallsJson(parsed.toolCalls, parsed.toolCallTurnIndexes, 0);
    }
  } catch {
    if (memorableAllowed) return { recorded: false, degradeReasons: ['memorable_relay_skipped_unscanned'] };
  }
  const dir = corpusDir();
  const corpusFile = join(dir, `${sessionId}.txt`);
  const tmpCorpus = `${corpusFile}.tmp-${process.pid}`;
  writeFileSync(tmpCorpus, text, { mode: 0o600 });
  renameSync(tmpCorpus, corpusFile);
  if (discoveryWasGuess) return { recorded: false, degradeReasons: ['memorable_relay_skipped_newest_guess'] };
  if (redactionsN === undefined) return { recorded: false, degradeReasons: ['memorable_relay_skipped_unscanned'] };
  return recordAndRelayReceipt({
    session_id: sessionId,
    harness: harnessOf(opts.harness),
    corpus_path: corpusFile,
    content_hash: contentHash(text),
    turn_count: parsed.turns.length,
    workspace_root: opts.cwd ?? (typeof opts.payload.cwd === 'string' ? opts.payload.cwd : process.cwd()),
    tool_calls_json: toolCallsJson,
    secret_scan_ok: true,
  }, { spawnFn: opts.spawnFn, trimRelayFile: true });
}

function readOpenclawBoundaryTail(path: string, maxBytes = 2 * 1024 * 1024): {
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  boundaryTurnIndexes: number[];
  toolCalls: Array<{ name: string; input: unknown }>;
  toolCallTurnIndexes: number[];
} | null {
  let raw: string;
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) {
      raw = readFileSync(path, 'utf8');
    } else {
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = readSync(fd, buf, 0, maxBytes, size - maxBytes);
        raw = buf.subarray(0, n).toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return null;
  }
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const boundaryTurnIndexes: number[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const toolCallTurnIndexes: number[] = [];
  let mappedAnything = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try { entry = JSON.parse(t); } catch { continue; }
    const mapped = mapOpenclawLine(entry);
    if (mapped.kind === 'message' || mapped.kind === 'skip') {
      for (const c of mapped.toolCalls ?? []) {
        toolCalls.push(c);
        toolCallTurnIndexes.push(turns.length);
      }
    }
    if (mapped.kind === 'session') mappedAnything = true;
    else if (mapped.kind === 'boundary') {
      mappedAnything = true;
      boundaryTurnIndexes.push(turns.length);
    } else if (mapped.kind === 'message') {
      mappedAnything = true;
      turns.push({ role: mapped.message.role, text: mapped.message.text });
    }
  }
  return mappedAnything ? { turns, boundaryTurnIndexes, toolCalls, toolCallTurnIndexes } : null;
}

export async function captureAndRelayOpenclawCompact(opts: {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  spawnFn?: typeof spawn;
}): Promise<RelayReceiptResult> {
  const cfg = loadConfig();
  if (!(await memorableGateAllowed(cfg)).allowed) return { recorded: false, degradeReasons: [] };
  const tail = readOpenclawBoundaryTail(opts.sessionFile);
  if (!tail) return { recorded: false, degradeReasons: ['unparseable'] };
  const from = tail.boundaryTurnIndexes.length ? tail.boundaryTurnIndexes[tail.boundaryTurnIndexes.length - 1]! : 0;
  const windowTurns = tail.turns.slice(from).slice(-40);
  if (!windowTurns.length) return { recorded: false, degradeReasons: ['empty_window'] };
  const text = toCorpusText(windowTurns);
  if (!text.trim()) return { recorded: false, degradeReasons: ['empty_window'] };
  try {
    const scan = await import('../secret-scan.ts');
    if (scan.redactFindings(text, { highEntropy: true }).redactions.length > 0) {
      return { recorded: false, degradeReasons: ['entropy_hit'] };
    }
  } catch {
    return { recorded: false, degradeReasons: ['scan_unavailable'] };
  }
  const startTurnIndex = tail.turns.length - windowTurns.length;
  const toolCallsJson = await redactedToolCallsJson(tail.toolCalls, tail.toolCallTurnIndexes, startTurnIndex);
  const dir = corpusDir();
  const hash = contentHash(text);
  const corpusFile = join(dir, `${sanitizeSessionId(opts.sessionId)}.seg-${hash}.txt`);
  writeFileSync(corpusFile, text, { mode: 0o600 });
  return recordAndRelayReceipt({
    session_id: sanitizeSessionId(opts.sessionId),
    harness: 'openclaw',
    corpus_path: corpusFile,
    content_hash: hash,
    turn_count: windowTurns.length,
    workspace_root: opts.workspaceDir,
    tool_calls_json: toolCallsJson,
    secret_scan_ok: true,
  }, { spawnFn: opts.spawnFn, skipReceiptsCompaction: true, trimRelayFile: true });
}
