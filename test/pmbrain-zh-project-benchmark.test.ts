import { describe, expect, test } from 'bun:test';
import { scorePmbrainZhBenchmark } from '../src/eval/pmbrain-zh-project/harness.ts';

describe('PMBrain Chinese project benchmark metrics', () => {
  test('scores retrieval, citation, latency and tokens from one contract', () => {
    const report = scorePmbrainZhBenchmark([
      { id: 'q1', family: 'risk', query: '风险是什么', relevantSlugs: ['projects/a'] },
      { id: 'q2', family: 'amount', query: '金额是多少', relevantSlugs: ['projects/b'] },
    ], [
      { questionId: 'q1', rankedSlugs: ['projects/a'], citedSlugs: ['projects/a'], latencyMs: 10, tokenUsage: 20 },
      { questionId: 'q2', rankedSlugs: ['projects/x', 'projects/b'], citedSlugs: ['projects/x'], latencyMs: 30, tokenUsage: 40 },
    ]);

    expect(report.recall_at_5).toBe(1);
    expect(report.mrr).toBe(0.75);
    expect(report.correct_document_hit_rate).toBe(1);
    expect(report.top_1_hit_rate).toBe(0.5);
    expect(report.citation_correctness).toBe(0.5);
    expect(report.average_latency_ms).toBe(20);
    expect(report.total_token_usage).toBe(60);
  });
});
