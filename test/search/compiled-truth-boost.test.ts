import { describe, test, expect } from 'bun:test';
import { compiledTruthBoost } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(extra: Partial<SearchResult>): SearchResult {
  return {
    slug: 'notes/x', title: 'X', score: 1, type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1, chunk_source: 'compiled_truth', chunk_text: 'real body text',
    ...extra,
  } as unknown as SearchResult;
}

describe('compiledTruthBoost — synthetic-title-row predicate boundaries', () => {
  test('chunk_id 0 + real text IS boosted (a genuine first chunk)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 0, chunk_text: 'real body text' }), true)).toBeGreaterThan(1);
  });

  test('nonzero chunk_id + empty text IS boosted (only the chunk_id-0 synthetic shape is excluded)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 7, chunk_text: '' }), true)).toBeGreaterThan(1);
  });

  test('chunk_id 0 + whitespace-only text is NOT boosted (trimmed-empty counts as empty)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 0, chunk_text: '   \n\t ' }), true)).toBe(1.0);
  });

  test('chunk_id 0 + undefined text is NOT boosted (missing text is the synthetic shape)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 0, chunk_text: undefined }), true)).toBe(1.0);
  });

  test('applyBoost=false, a non-compiled_truth source, and an unverified row all stay at 1.0', () => {
    expect(compiledTruthBoost(row({}), false)).toBe(1.0);
    expect(compiledTruthBoost(row({ chunk_source: 'timeline' }), true)).toBe(1.0);
    expect(compiledTruthBoost(row({ unverified: true }), true)).toBe(1.0);
  });
});
