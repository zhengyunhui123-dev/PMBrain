import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { throwIfAborted } from '../abort-check.ts';

const MIN_QUOTE_CHARS = 15;

const MAX_QUOTES_PER_PAGE = 200;

const NEAR_MATCH_FLOOR = 0.8;
const NEAR_MATCH_AMBIGUITY = 0.05;

const MAX_ANCHOR_CANDIDATES = 50;
const MAX_ANCHOR_PROBES = 200;
const MAX_NEAR_TRIGRAMS = 50;
const MAX_NEAR_QUOTE_NORM_CHARS = 2000;

const WINDOW_GROWTH = 1.2;
const WINDOW_SLACK_BEFORE = 20;
const WINDOW_SLACK_AFTER = 40;

const MAX_NUMERIC_CLAIMS_PER_PAGE = 200;

function maskNonProse(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, m => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    .replace(/\[\[[^\]]*\]\]/g, m => ' '.repeat(m.length))
    .replace(/\]\([^)]*\)/g, m => ' '.repeat(m.length));
}

export interface QuoteVerifyStats {
  pages_checked: number;
  pages_repaired: number;
  quotes_total: number;
  exact: number;
  normalized_fixed: number;
  near_fixed: number;
  stripped: number;
  unbalanced: number;
  skipped_preexisting: number;
  skipped_no_transcript: number;

  numeric_claim_warns: number;

  errors: number;
}

function emptyStats(): QuoteVerifyStats {
  return {
    pages_checked: 0,
    pages_repaired: 0,
    quotes_total: 0,
    exact: 0,
    normalized_fixed: 0,
    near_fixed: 0,
    stripped: 0,
    unbalanced: 0,
    skipped_preexisting: 0,
    skipped_no_transcript: 0,
    numeric_claim_warns: 0,
    errors: 0,
  };
}

export function normalizeForGrounding(s: string): { norm: string; map: number[] } {
  return foldForGrounding(s, true) as { norm: string; map: number[] };
}

function foldForGrounding(s: string, withMap: boolean): { norm: string; map: number[] } | string {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;

  let idx = 0;
  for (const cp of s) {
    const i = idx;
    idx += cp.length;
    let ch = cp;
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (ch === '‘' || ch === '’' || ch === 'ʼ') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    else if (ch === '–' || ch === '—' || ch === '−') ch = '-';

    else if (ch === '…') ch = '...';
    if (pendingSpace) {
      out.push(' ');
      if (withMap) map.push(map.length > 0 ? map[map.length - 1] : i);
      pendingSpace = false;
    }
    const low = ch.toLowerCase();
    for (const lowCp of low) {
      out.push(lowCp);
      if (withMap) for (let k = 0; k < lowCp.length; k++) map.push(i);
    }
  }
  const norm = out.join('');
  return withMap ? { norm, map } : norm;
}

export function normForGrounding(s: string): string {
  return foldForGrounding(s, false) as string;
}

interface GroundedTranscript {
  content: string;
  norm: string;
  map: number[];
}

export interface TranscriptForVerify {
  content: string;

  hash6: string;
}

export function extractQuoteSpans(body: string): { spans: Array<{ start: number; end: number; inner: string }>; unbalanced: number } {
  const spans: Array<{ start: number; end: number; inner: string }> = [];
  let unbalanced = 0;
  const masked = maskNonProse(body);

  const bounds: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const m of masked.matchAll(/\n\s*\n/g)) {
    bounds.push({ start: cursor, end: m.index ?? 0 });
    cursor = (m.index ?? 0) + m[0].length;
  }
  bounds.push({ start: cursor, end: masked.length });

  for (const b of bounds) {
    const straight: number[] = [];
    const curlyOpen: number[] = [];
    const pairs: Array<[number, number]> = [];
    let paraUnbalanced = false;
    for (let i = b.start; i < b.end; i++) {
      const ch = masked[i];
      if (ch === '"') straight.push(i);
      else if (ch === '“') curlyOpen.push(i);
      else if (ch === '”') {
        const open = curlyOpen.pop();
        if (open === undefined) paraUnbalanced = true;
        else pairs.push([open, i]);
      }
    }
    if (curlyOpen.length > 0) paraUnbalanced = true;
    if (straight.length % 2 !== 0) paraUnbalanced = true;
    else for (let m = 0; m + 1 < straight.length; m += 2) pairs.push([straight[m], straight[m + 1]]);
    if (paraUnbalanced) unbalanced++;

    for (const [start, end] of pairs) {
      const inner = body.slice(start + 1, end);
      if (inner.length >= MIN_QUOTE_CHARS) spans.push({ start, end, inner });
      if (spans.length >= MAX_QUOTES_PER_PAGE) break;
    }
    if (spans.length >= MAX_QUOTES_PER_PAGE) break;
  }

  spans.sort((a, b2) => a.start - b2.start);
  const kept: typeof spans = [];
  let lastEnd = -1;
  for (const sp of spans) {
    if (sp.start < lastEnd) continue;
    kept.push(sp);
    lastEnd = sp.end;
  }
  return { spans: kept, unbalanced };
}

export type GroundResult =
  | { status: 'exact' }
  | { status: 'normalized' | 'near'; replacement: string }
  | { status: 'none' };

export function groundQuote(inner: string, t: GroundedTranscript): GroundResult {
  if (t.content.includes(inner)) return { status: 'exact' };

  const q = normalizeForGrounding(inner);
  if (q.norm.length === 0) return { status: 'none' };

  const pos = t.norm.indexOf(q.norm);
  if (pos >= 0) {
    const start = t.map[pos];
    const endIdx = t.map[pos + q.norm.length - 1];

    if (start === undefined || endIdx === undefined) return { status: 'none' };
    const replacement = t.content.slice(start, endIdx + 1);
    if (replacement.length === 0) return { status: 'none' };
    return replacement === inner ? { status: 'exact' } : { status: 'normalized', replacement };
  }

  if (q.norm.length > MAX_NEAR_QUOTE_NORM_CHARS) return { status: 'none' };
  const qTokens = q.norm.split(' ').filter(w => w.length > 0);
  if (qTokens.length < 4) return { status: 'none' };
  const triCount = qTokens.length - 2;
  const stride = Math.max(1, Math.ceil(triCount / MAX_NEAR_TRIGRAMS));
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  const seenStarts = new Set<number>();
  let probes = 0;
  for (let g = 0; g + 2 < qTokens.length && candidates.length < MAX_ANCHOR_CANDIDATES && probes < MAX_ANCHOR_PROBES; g += stride) {
    const gram = qTokens.slice(g, g + 3).join(' ');
    let from = 0;
    while (candidates.length < MAX_ANCHOR_CANDIDATES && probes < MAX_ANCHOR_PROBES) {
      probes++;
      const at = t.norm.indexOf(gram, from);
      if (at < 0) break;
      from = at + 1;

      const targetLen = q.norm.length;
      let winStart = Math.max(0, at - Math.floor(g / Math.max(1, qTokens.length) * targetLen) - WINDOW_SLACK_BEFORE);
      let winEnd = Math.min(t.norm.length, winStart + Math.ceil(targetLen * WINDOW_GROWTH) + WINDOW_SLACK_AFTER);
      while (winStart > 0 && t.norm[winStart] !== ' ') winStart--;
      while (winEnd < t.norm.length && t.norm[winEnd] !== ' ') winEnd++;
      if (seenStarts.has(winStart)) continue;
      seenStarts.add(winStart);
      const winTokens = t.norm.slice(winStart, winEnd).split(' ').filter(w => w.length > 0);
      const counts = new Map<string, number>();
      for (const w of winTokens) counts.set(w, (counts.get(w) ?? 0) + 1);
      let hit = 0;
      for (const w of qTokens) {
        const c = counts.get(w) ?? 0;
        if (c > 0) { hit++; counts.set(w, c - 1); }
      }
      candidates.push({ start: winStart, end: winEnd, score: hit / qTokens.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < NEAR_MATCH_FLOOR) return { status: 'none' };
  const second = candidates.find(c => c.start !== best.start);
  if (second && best.score - second.score < NEAR_MATCH_AMBIGUITY && second.score >= NEAR_MATCH_FLOOR) {

    return { status: 'none' };
  }
  const oStart = t.map[best.start];
  const oEndIdx = t.map[Math.max(best.start, best.end - 1)];
  if (oStart === undefined || oEndIdx === undefined) return { status: 'none' };
  const replacement = t.content.slice(oStart, oEndIdx + 1).trim();
  if (replacement.length === 0) return { status: 'none' };
  return { status: 'near', replacement };
}

export function countUngroundedNumericClaims(body: string, t: GroundedTranscript): number {

  const masked = maskNonProse(body);
  const claimRe = /\$[\d,]+(?:\.\d+)?[kmbKMB]?|\b\d+(?:\.\d+)?%|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b\d{4,}\b/gi;
  let warns = 0;
  const seen = new Set<string>();
  for (const m of masked.match(claimRe) ?? []) {
    if (seen.size >= MAX_NUMERIC_CLAIMS_PER_PAGE) break;
    const claim = normForGrounding(m);
    if (claim.length === 0 || seen.has(claim)) continue;
    seen.add(claim);
    if (!t.norm.includes(claim)) warns++;
  }
  return warns;
}

function splitFrontmatter(md: string): { fm: string; body: string } {
  if (md.startsWith('---\n')) {
    const end = md.indexOf('\n---\n', 4);
    if (end >= 0) return { fm: md.slice(0, end + 5), body: md.slice(end + 5) };
  }
  return { fm: '', body: md };
}

export function repairBody(body: string, t: GroundedTranscript): {
  body: string;
  changed: boolean;
  quotes: number;
  exact: number;
  normalized: number;
  near: number;
  stripped: number;
  unbalanced: number;
} {
  const { spans, unbalanced } = extractQuoteSpans(body);
  let out = body;
  let exact = 0, normalized = 0, near = 0, stripped = 0;

  for (const sp of [...spans].sort((a, b) => b.start - a.start)) {
    const g = groundQuote(sp.inner, t);
    if (g.status === 'exact') { exact++; continue; }
    if (g.status === 'normalized' || g.status === 'near') {
      if (g.status === 'normalized') normalized++; else near++;

      const flat = g.replacement.replace(/\s*\n\s*/g, ' ');
      out = out.slice(0, sp.start + 1) + flat + out.slice(sp.end);
      continue;
    }

    stripped++;
    out = out.slice(0, sp.start) + sp.inner + out.slice(sp.end + 1);
  }
  return { body: out, changed: out !== body, quotes: spans.length, exact, normalized, near, stripped, unbalanced };
}

export async function verifyAndRepairDreamPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string }>,
  transcriptsByPath: Map<string, TranscriptForVerify>,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteVerifyStats> {
  const stats = emptyStats();

  const seen = new Set<string>();
  const byTranscript = new Map<string, Array<{ slug: string; source_id: string }>>();
  for (const ref of refs) {
    const key = `${ref.source_id} ${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = ref.raw_source ? transcriptsByPath.get(ref.raw_source) : undefined;
    if (!t) { stats.skipped_no_transcript++; continue; }

    if (!ref.slug.includes(`-${t.hash6}`)) { stats.skipped_preexisting++; continue; }
    const group = byTranscript.get(ref.raw_source as string);
    if (group) group.push({ slug: ref.slug, source_id: ref.source_id });
    else byTranscript.set(ref.raw_source as string, [{ slug: ref.slug, source_id: ref.source_id }]);
  }

  for (const [rawSource, group] of byTranscript) {
    throwIfAborted(opts.signal, '[dream] quote verify');
    const t = transcriptsByPath.get(rawSource)!;
    const { norm, map } = normalizeForGrounding(t.content);
    const grounded: GroundedTranscript = { content: t.content, norm, map };

    for (const ref of group) {
      throwIfAborted(opts.signal, '[dream] quote verify');
      try {
        const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
        if (!page) { stats.errors++; continue; }
        stats.pages_checked++;
        const tags = await engine.getTags(ref.slug, { sourceId: ref.source_id });
        const md = serializePageToMarkdown(page, tags);
        const { fm, body } = splitFrontmatter(md);
        const r = repairBody(body, grounded);
        stats.quotes_total += r.quotes;
        stats.exact += r.exact;
        stats.normalized_fixed += r.normalized;
        stats.near_fixed += r.near;
        stats.stripped += r.stripped;
        stats.unbalanced += r.unbalanced;
        stats.numeric_claim_warns += countUngroundedNumericClaims(r.body, grounded);
        if (r.changed) {

          await importFromContent(engine, ref.slug, fm + r.body, {
            noEmbed: true,
            remote: false,
            sourceId: ref.source_id,
          });
          stats.pages_repaired++;
        }
      } catch (e) {

        throwIfAborted(opts.signal, '[dream] quote verify');
        stats.errors++;
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[dream] quote verify ${ref.slug}@${ref.source_id} failed: ${msg}\n`);
      }

      await new Promise(resolve => setTimeout(resolve, 0));
    }

  }
  return stats;
}
