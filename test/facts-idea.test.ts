import { afterEach, expect, test } from 'bun:test';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';
import { ALL_FACT_KINDS, type BrainEngine } from '../src/core/engine.ts';
import { HALFLIFE_DAYS } from '../src/core/facts/decay.ts';
import { FACT_KINDS } from '../shared/knowledge-views.ts';

afterEach(() => { __setChatTransportForTests(null); resetGateway(); });

test('idea joins facts taxonomy with upstream decay while old kinds remain', () => {
  expect(ALL_FACT_KINDS).toEqual(['event', 'preference', 'commitment', 'belief', 'fact', 'idea']);
  expect((HALFLIFE_DAYS as Record<string, number>).idea).toBe(365);
  expect([...FACT_KINDS]).toEqual([...ALL_FACT_KINDS]);
});

test('Chinese idea survives extraction and the configured appendix reaches the model', async () => {
  let system = '';
  __setChatTransportForTests(async request => {
    system = request.system ?? '';
    return { text: JSON.stringify({ facts: [{ fact: '建议尝试订阅服务，尚未决定实施。', kind: 'idea', confidence: 0.8, notability: 'medium' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
  });
  const engine = { getConfig: async (key: string) => key === 'facts.extraction_prompt_appendix' ? '保留会议中的待确认事项。' : null } as unknown as BrainEngine;
  const facts = await extractFactsFromTurn({ turnText: '建议尝试订阅服务，尚未决定实施。', source: 'test', engine });
  expect(facts[0]?.kind as string).toBe('idea');
  expect(facts[0]?.fact).toBe('建议尝试订阅服务，尚未决定实施。');
  expect(system).toContain('保留会议中的待确认事项。');
  expect(system).toContain('尚未决定');
  expect(system).toContain('进度追问');
  expect(system).toContain('桌面');
  expect(system).toContain('可以先放着');
  expect(system).toContain('不要输出 question');
});

test('unknown extractor kinds are dropped instead of stored as fact', async () => {
  __setChatTransportForTests(async () => ({
    text: JSON.stringify({ facts: [
      { fact: '对齐Gbrain都完成了吗？', kind: 'question', confidence: 0, notability: 'low' },
      { fact: '以后 GitHub 由我自己提交。', kind: 'commitment', confidence: 0.8, notability: 'medium' },
    ] }),
    blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test',
  }));
  const facts = await extractFactsFromTurn({ turnText: '对齐Gbrain都完成了吗？以后 GitHub 由我自己提交。', source: 'test' });
  expect(facts.map(fact => ({ fact: fact.fact, kind: fact.kind }))).toEqual([
    { fact: '以后 GitHub 由我自己提交。', kind: 'commitment' },
  ]);
});
