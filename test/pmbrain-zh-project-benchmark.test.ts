import { describe, expect, test } from 'bun:test';
import { scorePmbrainZhBenchmark } from '../src/eval/pmbrain-zh-project/harness.ts';

describe('PMBrain Chinese project benchmark metrics', () => {
  test('未运行回答模型不能把检索结果当引用打分，缺失与失败的查询不冒充成功', () => {
    const questions = [
      { id: 'q1', family: 'risk' as const, query: '风险是什么', relevantSlugs: ['projects/a'] },
      { id: 'q2', family: 'risk' as const, query: '第二个风险', relevantSlugs: ['projects/b'] },
    ];
    const report = scorePmbrainZhBenchmark(questions, [{ questionId: 'q1', rankedSlugs: ['projects/a'], latencyMs: 10, tokenUsage: 0 }]);
    expect(report.citation_correctness).toBeNull();
    expect(report.citation_evaluated_questions).toBe(0);
    expect(report.unobserved_questions).toBe(1);
    expect(report.per_question).toHaveLength(2);
    expect(report.per_question[1].status).toBe('missing');
  });

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

  test('错误结果不参与成功打分，跨Source同名页不能计为命中或隔离通过', () => {
    const report = scorePmbrainZhBenchmark([
      { id: 'scoped', family: 'risk', query: '同名项目', sourceId: 'alpha', relevantSlugs: ['alpha:projects/same'] },
      { id: 'failed', family: 'risk', query: '失败问题', relevantSlugs: ['projects/a'] },
    ], [
      { questionId: 'scoped', rankedSlugs: ['beta:projects/same'], latencyMs: 1, tokenUsage: 0 },
      { questionId: 'failed', rankedSlugs: ['projects/a'], citedSlugs: ['projects/a'], latencyMs: 2, tokenUsage: 0, error: '检索失败' },
    ]);
    expect(report.recall_at_5).toBe(0);
    expect(report.source_isolation_accuracy).toBe(0);
    expect(report.queries_errored).toBe(1);
    expect(report.citation_correctness).toBeNull();
    expect(report.per_question[1].status).toBe('error');
  });
});
