import { describe, expect, test } from 'bun:test';
import {
  hybridSearchCached,
  queryCacheRequestBypassReason,
} from '../src/core/search/hybrid.ts';
import {
  KNOBS_HASH_VERSION,
  knobsHash,
  resolveSearchMode,
} from '../src/core/search/mode.ts';

describe('P1 query-cache isolation contract', () => {
  const knobs = resolveSearchMode({ mode: 'balanced' });

  test('cache epoch advances after folding the new isolation inputs', () => {
    expect(KNOBS_HASH_VERSION).toBe(11);
  });

  test('hard excludes are order-insensitive but policy-sensitive', () => {
    const a = knobsHash(knobs, { hardExcludes: ['archive/', 'test/'] });
    const reordered = knobsHash(knobs, { hardExcludes: ['test/', 'archive/'] });
    const changed = knobsHash(knobs, { hardExcludes: ['archive/', 'private/'] });
    expect(a).toBe(reordered);
    expect(a).not.toBe(changed);
  });

  test('detail, salience and recency each split the cache namespace', () => {
    expect(knobsHash(knobs, { detail: 'low' }))
      .not.toBe(knobsHash(knobs, { detail: 'high' }));
    expect(knobsHash(knobs, { salience: 'off' }))
      .not.toBe(knobsHash(knobs, { salience: 'strong' }));
    expect(knobsHash(knobs, { recency: 'off' }))
      .not.toBe(knobsHash(knobs, { recency: 'on' }));
  });

  test('unkeyed filters and every nonzero offset bypass cache reads and writes', () => {
    expect(queryCacheRequestBypassReason({ since: '7d' })).toBe('date_filter');
    expect(queryCacheRequestBypassReason({ types: ['person'] })).toBe('type_filter');
    expect(queryCacheRequestBypassReason({ type: 'person' })).toBe('type_filter');
    expect(queryCacheRequestBypassReason({ offset: 20 })).toBe('pagination');
    expect(queryCacheRequestBypassReason({ offset: -1 })).toBe('pagination');
    expect(queryCacheRequestBypassReason({ exclude_slugs: ['private/page'] }))
      .toBe('exact_slug_filter');
    expect(queryCacheRequestBypassReason({ language: 'typescript' })).toBe('code_filter');
    expect(queryCacheRequestBypassReason({}, true)).toBe('date_filter');
    expect(queryCacheRequestBypassReason({ offset: 0 })).toBeNull();
  });

  test('cached wrapper keeps one shared deadline for lookup and inner search', async () => {
    const source = await Bun.file(
      new URL('../src/core/search/hybrid.ts', import.meta.url),
    ).text();
    const fnStart = source.indexOf('export async function hybridSearchCached');
    const fnEnd = source.indexOf('\n/**\n * RRF/dedup identity', fnStart);
    const body = source.slice(fnStart, fnEnd);
    expect(body.match(/makeQueryEmbedDeadline\(\)/g)).toHaveLength(1);
    expect(body).toContain('embedQueryBounded(query, undefined, queryEmbedDeadline)');
    expect(body).toContain('_queryEmbedDeadline: queryEmbedDeadline');
    expect(typeof hybridSearchCached).toBe('function');
  });
});
