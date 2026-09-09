import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_METADATA_BOOST_GATE,
  METADATA_BOOST_GATES,
  decideMetadataBoosts,
  lexicalArmsVoted,
  normalizeMetadataBoostGate,
} from '../../src/core/search/metadata-boost-gate.ts';
import {
  MODE_BUNDLES,
  SEARCH_MODES,
  SEARCH_MODE_CONFIG_KEYS,
  knobsHash,
  loadOverridesFromConfig,
  resolveSearchMode,
} from '../../src/core/search/mode.ts';
import { runPostFusionStages } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, page_id: number, score: number): SearchResult {
  return {
    slug,
    page_id,
    title: slug,
    type: 'note',
    chunk_text: `${slug} body`,
    chunk_source: 'timeline',
    chunk_id: page_id,
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
  };
}

describe('metadata boost gate', () => {
  test('accepts always/lexical and treats anything else as unset', () => {
    expect(METADATA_BOOST_GATES).toEqual(['always', 'lexical']);
    expect(DEFAULT_METADATA_BOOST_GATE).toBe('always');
    expect(normalizeMetadataBoostGate(' LEXICAL ')).toBe('lexical');
    expect(normalizeMetadataBoostGate('off')).toBeUndefined();
    expect(normalizeMetadataBoostGate(true)).toBeUndefined();
  });

  test('lexical vote is keyword, title, or included relational rows', () => {
    expect(lexicalArmsVoted({
      keywordFusionList: [],
      titleFusionList: [],
      relationalList: [row('r', 1, 1)],
      includeRelational: false,
    })).toBe(false);
    expect(lexicalArmsVoted({
      keywordFusionList: [],
      titleFusionList: [row('t', 2, 1)],
      relationalList: [],
      includeRelational: true,
    })).toBe(true);
  });

  test('lexical gate skips metadata boosts when only vector voted', () => {
    expect(decideMetadataBoosts({ gate: 'lexical', lexicalVoted: false }).reason).toBe('vector_only_voter');
    expect(decideMetadataBoosts({ gate: 'lexical', lexicalVoted: false, modality: 'image' }).boosts_applied).toBe(true);
    expect(decideMetadataBoosts({ gate: 'always', lexicalVoted: false }).boosts_applied).toBe(true);
  });

  test('every mode bundle defaults to lexical and pin 3', () => {
    for (const mode of SEARCH_MODES) {
      expect(MODE_BUNDLES[mode].metadata_boost_gate).toBe('lexical');
      expect(MODE_BUNDLES[mode].relational_rerank_pin).toBe(3);
    }
    expect(MODE_BUNDLES.tokenmax.autocut).toBe(false);
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.metadata_boost_gate');
    expect(SEARCH_MODE_CONFIG_KEYS).toContain('search.relational_rerank_pin');
  });

  test('config and knobs hash distinguish lexical from always', () => {
    const lexical = resolveSearchMode({ mode: 'balanced' });
    const always = resolveSearchMode({
      mode: 'balanced',
      overrides: loadOverridesFromConfig({ 'search.metadata_boost_gate': 'always' }),
    });
    expect(lexical.metadata_boost_gate).toBe('lexical');
    expect(always.metadata_boost_gate).toBe('always');
    expect(knobsHash(lexical)).not.toBe(knobsHash(always));
  });

  test('skipMetadataBoosts leaves hub scores unchanged', async () => {
    const results = [row('concepts/pricing', 1, 1.0), row('companies/acme', 2, 0.98)];
    const engine = {
      getBacklinkCounts: async () => new Map([[2, 80]]),
      getSalienceScores: async () => new Map(),
      getEffectiveDates: async () => new Map(),
      executeRaw: async () => [],
    } as never;
    await runPostFusionStages(engine, results, {
      applyBacklinks: true,
      salience: 'off',
      recency: 'off',
      skipMetadataBoosts: true,
    });
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBe(0.98);
    expect(results[1].backlink_boost).toBeUndefined();
  });
});
