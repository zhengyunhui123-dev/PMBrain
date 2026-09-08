import type { SearchResult } from '../types.ts';

export const RELATIONAL_RERANK_PIN_MAX = 10;
export const DEFAULT_RELATIONAL_RERANK_PIN = 3;

export function normalizeRelationalRerankPin(v: unknown): number | undefined {
  if (v === false) return 0;
  if (typeof v === 'string') {
    const lit = v.trim().toLowerCase();
    if (lit === 'off' || lit === 'false') return 0;
    if (lit === '') return undefined;
    return normalizeRelationalRerankPin(Number(lit));
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= RELATIONAL_RERANK_PIN_MAX) return v;
  return undefined;
}

export interface RelationalRerankPinnedRow {
  slug: string;
  source_id: string;
  from_rank: number;
  to_rank: number;
  fused_rank: number;
}

export interface RelationalRerankPinDecision {
  max: number;
  relational_in_pool: number;
  pinned: RelationalRerankPinnedRow[];
  moved: number;
}

export interface PinRelationalRowsOpts {
  max: number;
  fusedOrder?: readonly SearchResult[];
  onPin?: (decision: RelationalRerankPinDecision) => void;
}

const pageKey = (r: SearchResult): string => `${r.source_id ?? 'default'}:${r.slug}`;

export function pinRelationalRows(
  reranked: SearchResult[],
  relationalList: readonly SearchResult[],
  opts: PinRelationalRowsOpts,
): SearchResult[] {
  const max = Number.isFinite(opts.max) ? Math.floor(opts.max) : 0;
  if (max <= 0 || reranked.length === 0 || relationalList.length === 0) return reranked;

  const relKeys = new Set(relationalList.map(pageKey));
  const fusedRank = new Map<string, number>();
  for (const r of opts.fusedOrder ?? []) {
    const k = pageKey(r);
    if (relKeys.has(k) && !fusedRank.has(k)) fusedRank.set(k, fusedRank.size);
  }
  for (const r of relationalList) {
    const k = pageKey(r);
    if (!fusedRank.has(k)) fusedRank.set(k, fusedRank.size);
  }

  const seen = new Set<string>();
  const candidates: Array<{ idx: number; fused: number; claim: number }> = [];
  for (let i = 0; i < reranked.length; i++) {
    const k = pageKey(reranked[i]);
    if (!relKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    const fused = fusedRank.get(k)!;
    candidates.push({ idx: i, fused, claim: Math.min(fused, i) });
  }
  if (candidates.length === 0) return reranked;

  candidates.sort((a, b) => a.claim - b.claim || a.fused - b.fused || a.idx - b.idx);
  const block = candidates.slice(0, max);
  const blockIdx = new Set(block.map(c => c.idx));

  const out: SearchResult[] = [];
  const pinned: RelationalRerankPinnedRow[] = [];
  let moved = 0;
  for (const c of block) {
    const row = reranked[c.idx];
    const to = out.length;
    if (to !== c.idx) moved++;
    pinned.push({
      slug: row.slug,
      source_id: row.source_id ?? 'default',
      from_rank: c.idx,
      to_rank: to,
      fused_rank: c.fused,
    });
    out.push({ ...row, relational_pinned: true });
  }
  for (let i = 0; i < reranked.length; i++) {
    if (!blockIdx.has(i)) out.push(reranked[i]);
  }

  try {
    opts.onPin?.({ max, relational_in_pool: candidates.length, pinned, moved });
  } catch {
    // Meta stamping must never break search.
  }
  return out;
}
