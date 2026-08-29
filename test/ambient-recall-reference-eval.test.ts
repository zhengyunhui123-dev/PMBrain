import { describe, expect, test } from 'bun:test';
import {
  computeAmbientRecallMetrics,
  validateAmbientRecallFixture,
  type AmbientRecallFixture,
  type AmbientTurnOutcome,
} from '../scripts/eval-ambient-recall-reference.ts';

const FIXTURE: AmbientRecallFixture = {
  schema_version: 1,
  name: 'contract',
  max_pointers: 3,
  thresholds: {
    know_to_ask_failure_rate_max: 0.05,
    false_fire_rate_max: 0.05,
    push_precision_min: 0.95,
    push_recall_min: 0.8,
    source_isolation_violations_max: 0,
    p95_latency_ms_max: 150,
  },
  pages: [
    {
      source_id: 'personal',
      slug: 'entities/alpha',
      title: 'Alpha',
      type: 'product',
      aliases: ['alpha'],
      summary: 'Synthetic page.',
    },
    {
      source_id: 'team',
      slug: 'entities/foreign',
      title: 'Foreign',
      type: 'product',
      aliases: ['foreign'],
      summary: 'Foreign synthetic page.',
    },
  ],
  turns: [
    {
      id: 'positive',
      query: 'What changed in Alpha?',
      active_source_id: 'personal',
      should_retrieve: true,
      gold: ['personal::entities/alpha'],
    },
    {
      id: 'negative',
      query: 'Continue the unfinished work.',
      active_source_id: 'personal',
      should_retrieve: false,
      gold: [],
    },
  ],
};

describe('ambient recall reference evaluator', () => {
  test('validates active-source gold and unique ids', () => {
    expect(validateAmbientRecallFixture(FIXTURE)).toEqual([]);
    expect(validateAmbientRecallFixture({
      ...FIXTURE,
      turns: [...FIXTURE.turns, { ...FIXTURE.turns[0]! }],
    })).toContain('duplicate turn id: positive');
  });

  test('scores know-to-ask, false fire, precision, recall, isolation, latency and tokens', () => {
    const outcomes: AmbientTurnOutcome[] = [
      {
        turn_id: 'positive',
        latency_ms: 10,
        text: '- Alpha pointer',
        pointers: [{ source_id: 'personal', slug: 'entities/alpha' }],
      },
      {
        turn_id: 'negative',
        latency_ms: 20,
        text: '',
        pointers: [],
      },
    ];
    const metrics = computeAmbientRecallMetrics(FIXTURE, outcomes);
    expect(metrics.know_to_ask_failure_rate).toBe(0);
    expect(metrics.false_fire_rate).toBe(0);
    expect(metrics.push_precision).toBe(1);
    expect(metrics.push_recall).toBe(1);
    expect(metrics.source_isolation_violations).toBe(0);
    expect(metrics.p95_latency_ms).toBe(20);
    expect(metrics.avg_injected_tokens).toBeGreaterThan(0);
    expect(metrics.verdict).toBe('pass');
  });

  test('closed baseline makes the know-to-ask benefit explicit', () => {
    const outcomes = FIXTURE.turns.map((turn) => ({
      turn_id: turn.id,
      latency_ms: 0,
      text: '',
      pointers: [],
    }));
    const metrics = computeAmbientRecallMetrics(FIXTURE, outcomes);
    expect(metrics.know_to_ask_failure_rate).toBe(1);
    expect(metrics.push_recall).toBe(0);
    expect(metrics.push_precision).toBeNull();
    expect(metrics.verdict).toBe('fail');
  });

  test('foreign-source pointers fail the invariant even when precision is otherwise high', () => {
    const outcomes: AmbientTurnOutcome[] = [
      {
        turn_id: 'positive',
        latency_ms: 1,
        text: '- Alpha\n- Foreign',
        pointers: [
          { source_id: 'personal', slug: 'entities/alpha' },
          { source_id: 'team', slug: 'entities/foreign' },
        ],
      },
      { turn_id: 'negative', latency_ms: 1, text: '', pointers: [] },
    ];
    const metrics = computeAmbientRecallMetrics(FIXTURE, outcomes);
    expect(metrics.source_isolation_violations).toBe(1);
    expect(metrics.verdict).toBe('fail');
  });
});
