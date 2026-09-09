import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RELATIONAL_RERANK_PIN,
  normalizeRelationalRerankPin,
  pinRelationalRows,
} from '../../src/core/search/relational-rerank-pin.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug,
    page_id: 0,
    title: slug,
    type: 'note',
    chunk_text: `text of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0.5,
    stale: false,
    source_id: 'default',
    ...extra,
  };
}

const slugs = (rs: readonly SearchResult[]) => rs.map(r => r.slug);
const rel = (slug: string) => row(slug, { relational_via_link_types: ['invested_in'] });

describe('relational rerank pin', () => {
  test('off/false and out of range fall through', () => {
    expect(DEFAULT_RELATIONAL_RERANK_PIN).toBe(3);
    expect(normalizeRelationalRerankPin('off')).toBe(0);
    expect(normalizeRelationalRerankPin(3)).toBe(3);
    expect(normalizeRelationalRerankPin(11)).toBeUndefined();
    expect(normalizeRelationalRerankPin(1.5)).toBeUndefined();
  });

  test('empty arm or max 0 returns the same array', () => {
    const reranked = [row('t1'), row('t2')];
    expect(pinRelationalRows(reranked, [], { max: 3 })).toBe(reranked);
    expect(pinRelationalRows(reranked, [rel('r1')], { max: 0 })).toBe(reranked);
  });

  test('pins relational rows above reranked text in fused order', () => {
    const fused = [row('r-a'), row('t1'), row('r-b'), row('t2')];
    const reranked = [row('t1'), row('t2'), row('r-b'), row('r-a')];
    const out = pinRelationalRows(reranked, [rel('r-a'), rel('r-b')], { max: 3, fusedOrder: fused });
    expect(slugs(out)).toEqual(['r-a', 'r-b', 't1', 't2']);
    expect(out[0].relational_pinned).toBe(true);
    expect(out[1].relational_pinned).toBe(true);
    expect(out[2].relational_pinned).toBeUndefined();
  });
});
