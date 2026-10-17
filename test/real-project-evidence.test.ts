import { expect, test } from 'bun:test';
import { assessEvidence, summarizeRealProjectRun } from '../src/eval/real-project/evidence';

const source = { sourceId: 'team-a', slug: 'meeting', content: '10月8日决定延期。合同金额仍待确认。' };
test('a citation to the right page with an invented quote cannot pass', () => {
  const result = assessEvidence([{ text: '合同为100万元。', citations: [{ sourceId: 'team-a', slug: 'meeting', quote: '合同为100万元' }] }], [source], 'team-a');
  expect(result.quoteAccuracy).toBe(0); expect(result.invalid).toHaveLength(1);
});
test('a quoted statement from a different Source is rejected', () => {
  const result = assessEvidence([{ text: '决定延期。', citations: [{ sourceId: 'team-b', slug: 'meeting', quote: '10月8日决定延期' }] }], [{ ...source, sourceId: 'team-b' }], 'team-a');
  expect(result.sourceAccuracy).toBe(0); expect(result.quoteAccuracy).toBe(0);
});
test('a real quote is mechanical evidence, while semantic support requires an explicit assessment', () => {
  const evidence = assessEvidence([{ text: '10月8日决定延期。', citations: [{ sourceId: 'team-a', slug: 'meeting', quote: '10月8日决定延期' }] }], [source], 'team-a');
  expect(evidence.quoteAccuracy).toBe(1);
  expect(summarizeRealProjectRun([{ id: 'q1', recallAt5: 1, reciprocalRank: 1, evidence, judgement: null, error: null }]).fullQualityGate).toBe('not_evaluated');
});
test('failures and missing semantic evidence remain in the denominator', () => {
  const evidence = assessEvidence([], [], 'team-a');
  const report = summarizeRealProjectRun([{ id: 'q1', recallAt5: 0, reciprocalRank: 0, evidence, judgement: null, error: 'provider unavailable' }]);
  expect(report.errors).toBe(1); expect(report.recallAt5).toBe(0); expect(report.answerAccuracy).toBe(null);
});
test('PDF soft wraps do not change a Chinese quote, while English word boundaries remain significant', () => {
  const documents = [{ ...source, content: '合同金额仍待\n确认。We work now here.' }];
  expect(assessEvidence([{ text: '待确认。', citations: [{ ...source, quote: '合同金额仍待确认' }] }], documents, 'team-a').quoteAccuracy).toBe(1);
  expect(assessEvidence([{ text: 'nowhere', citations: [{ ...source, quote: 'work nowhere' }] }], documents, 'team-a').quoteAccuracy).toBe(0);
});
test('a citation may refer to any retrieved chunk of the same source-qualified page', () => {
  const documents = [{ ...source, content: '第一段讨论计划。' }, { ...source, content: '第二段说明合同仍待确认。' }];
  expect(assessEvidence([{ text: '合同待确认。', citations: [{ ...source, quote: '合同仍待确认' }] }], documents, 'team-a').quoteAccuracy).toBe(1);
});
