/**
 * detect.ts — format detection for the connector transcript ingest lane.
 *
 * PR3 ships ChatGPT + Claude export adapters only. Discovery of coding-harness
 * session logs is out of scope.
 */

import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import type { TranscriptAdapter, TranscriptFormat } from './types.ts';
import { chatgptExportAdapter } from './chatgpt-export.ts';
import { claudeExportAdapter } from './claude-export.ts';

export function transcriptAdapters(): TranscriptAdapter[] {
  return [claudeExportAdapter, chatgptExportAdapter];
}

const SAMPLE_BYTES = 64 * 1024;

export function readSample(path: string, bytes = SAMPLE_BYTES): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export type DetectResult =
  | { ok: true; adapter: TranscriptAdapter }
  | { ok: false; reason: 'unreadable' | 'symlink' | 'unknown_format'; tried: TranscriptFormat[] };

export function detectAdapter(
  path: string,
  opts: { explicitFormat?: TranscriptFormat; adapters?: TranscriptAdapter[] } = {},
): DetectResult {
  const adapters = opts.adapters ?? transcriptAdapters();
  if (opts.explicitFormat) {
    const adapter = adapters.find((a) => a.format === opts.explicitFormat);
    if (adapter) return { ok: true, adapter };
    return { ok: false, reason: 'unknown_format', tried: adapters.map((a) => a.format) };
  }
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink', tried: [] };
  } catch {
    return { ok: false, reason: 'unreadable', tried: [] };
  }
  let sample: Buffer;
  try {
    sample = readSample(path);
  } catch {
    return { ok: false, reason: 'unreadable', tried: [] };
  }
  for (const adapter of adapters) {
    if (adapter.detect(path, sample)) return { ok: true, adapter };
  }
  return { ok: false, reason: 'unknown_format', tried: adapters.map((a) => a.format) };
}
