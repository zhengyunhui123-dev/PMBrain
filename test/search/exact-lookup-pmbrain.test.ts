import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { applyExactLookupTier, structuralExactLookup } from '../../src/core/search/exact-lookup.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice', {
    title: 'Alice Example', type: 'person', frontmatter: {}, compiled_truth: 'Alice profile', timeline: '',
  });
  await engine.putPage('people/private-alice', {
    title: 'Private Alice', type: 'person', frontmatter: { visibility: 'private' }, compiled_truth: 'Secret', timeline: '',
  });
});

afterAll(async () => engine.disconnect());

describe('structural exact lookup tier', () => {
  test('an exact slug is promoted ahead of a higher-scored organic row', async () => {
    const organic = [{ slug: 'notes/other', source_id: 'default', score: 0.9 }] as SearchResult[];
    const rows = await applyExactLookupTier(engine, organic, 'people/alice', { sourceId: 'default' });
    expect(rows[0].slug).toBe('people/alice');
    expect(rows[0].exact_lookup).toBe('slug');
  });

  test('the exact normalized title arm is promoted without another broad query', async () => {
    const titleCandidate = {
      slug: 'people/alice', source_id: 'default', title: 'Alice Example', score: 0.2,
    } as SearchResult;
    const rows = await applyExactLookupTier(engine, [], 'alice example', { titleCandidates: [titleCandidate] });
    expect(rows[0].exact_lookup).toBe('title');
    expect(rows[0].title_match_boost).toBeGreaterThan(1);
  });

  test('remote private-page posture also applies to the direct slug probe', async () => {
    expect(await structuralExactLookup(engine, 'people/private-alice', {
      sourceId: 'default', excludePrivate: true,
    })).toEqual([]);
    expect((await structuralExactLookup(engine, 'people/private-alice', {
      sourceId: 'default', excludePrivate: false,
    }))[0]?.slug).toBe('people/private-alice');
  });
});
