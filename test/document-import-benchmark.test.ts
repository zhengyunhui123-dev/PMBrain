import { describe, expect, test } from 'bun:test';
import { scoreDocumentImportBenchmark } from '../src/eval/document-import-v2/harness.ts';

describe('Document import benchmark scoring', () => {
  test('scores retrieval rank and source locator separately', () => {
    const report = scoreDocumentImportBenchmark([
      { id: 'q1', query: '启动条件', expectedPath: 'plan.pdf', expectedLocator: '第 18 页' },
      { id: 'q2', query: '合同金额', expectedPath: 'contract.docx' },
    ], [
      { questionId: 'q1', rankedPaths: ['plan.pdf', 'other.pdf'], locatorMatched: true, latencyMs: 10 },
      { questionId: 'q2', rankedPaths: ['other.pdf', 'contract.docx'], locatorMatched: false, latencyMs: 20 },
    ]);
    expect(report.top1).toBe(0.5);
    expect(report.recallAt5).toBe(1);
    expect(report.mrr).toBe(0.75);
    expect(report.locatorAccuracy).toBe(1);
    expect(report.averageLatencyMs).toBe(15);
  });
});
