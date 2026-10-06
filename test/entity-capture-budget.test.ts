/**
 * 产品经理能看懂的测试说明：
 * 实体回填先算费用和候选，再决定要不要把下一份资料交给模型。
 * 这里不连数据库。它确认金额公式、Ollama、缺用量、缺价格、候选数量和任务详情上的数字。
 */
import { expect, test } from 'bun:test';
import { TaskProgressAdapter, finishTaskProgress } from '../src/product/tasks/progress-adapter.ts';
import {
  captureBudgetStop,
  captureChunkCostCny,
  parseEntityCaptureCostCapInput,
  rankCaptureCandidates,
  readEntityCaptureCostCap,
  readModelCnyPrices,
  usageFromJobResult,
} from '../src/core/cycle/entity-capture-budget.ts';

test('费用按真实用量和人民币单价计算，缺一项就不编造金额', () => {
  expect(captureChunkCostCny({
    usage: { present: true, input: 1_000_000, output: 500_000 },
    inputPriceCnyPerMillion: 2,
    outputPriceCnyPerMillion: 8,
    ollama: false,
  })).toBe(6);
  expect(captureChunkCostCny({
    usage: { present: false, input: 0, output: 0 },
    inputPriceCnyPerMillion: 2,
    outputPriceCnyPerMillion: 8,
    ollama: false,
  })).toBeNull();
  expect(captureChunkCostCny({
    usage: { present: true, input: 100, output: 100 },
    inputPriceCnyPerMillion: null,
    outputPriceCnyPerMillion: 8,
    ollama: false,
  })).toBeNull();
  expect(captureChunkCostCny({
    usage: { present: true, input: 100, output: 100 },
    inputPriceCnyPerMillion: 99,
    outputPriceCnyPerMillion: 99,
    ollama: true,
  })).toBe(0);
  expect(readModelCnyPrices([
    { provider: 'deepseek', models: [{ id: 'deepseek-chat', inputPrice: 1, outputPrice: 2, inputPriceCny: 3, outputPriceCny: 4 }] },
  ], 'deepseek:deepseek-chat', 'deepseek')).toEqual({ input: 3, output: 4 });
});

test('未配置费用上限时默认 5 元，不限制和自定义金额可以识别', () => {
  expect(readEntityCaptureCostCap(null)).toBe(5);
  expect(readEntityCaptureCostCap('unlimited')).toBeNull();
  expect(readEntityCaptureCostCap('12.5')).toBe(12.5);
  expect(parseEntityCaptureCostCapInput('unlimited')).toBeNull();
  expect(parseEntityCaptureCostCapInput(20)).toBe(20);
  expect(parseEntityCaptureCostCapInput('0')).toBeUndefined();
  expect(usageFromJobResult({ tokens: { missing: true } }).present).toBe(false);
  expect(usageFromJobResult({ tokens: { in: 0, out: 0 } })).toEqual({ present: true, input: 0, output: 0 });
});

test('页面额度按文档计，费用和 Token 可以在长文中间停住', () => {
  expect(captureBudgetStop({
    pagesSubmitted: 100, maxPages: 100, inputTokens: 1, outputTokens: 1,
    maxInputTokens: 100, maxOutputTokens: 100, usageKnown: true, costCny: 0, costCapCny: 5,
    checkingPageBudget: true,
  })).toBe('pages');
  expect(captureBudgetStop({
    pagesSubmitted: 100, maxPages: 100, inputTokens: 1, outputTokens: 1,
    maxInputTokens: 100, maxOutputTokens: 100, usageKnown: true, costCny: 0, costCapCny: 5,
    checkingPageBudget: false,
  })).toBeNull();
  expect(captureBudgetStop({
    pagesSubmitted: 1, maxPages: 100, inputTokens: 10, outputTokens: 1,
    maxInputTokens: 10, maxOutputTokens: 100, usageKnown: false, costCny: null, costCapCny: 5,
    checkingPageBudget: false,
  })).toBeNull();
  expect(captureBudgetStop({
    pagesSubmitted: 1, maxPages: 100, inputTokens: 10, outputTokens: 1,
    maxInputTokens: 10, maxOutputTokens: 100, usageKnown: true, costCny: null, costCapCny: 5,
    checkingPageBudget: false,
  })).toBe('tokens');
  expect(captureBudgetStop({
    pagesSubmitted: 1, maxPages: 100, inputTokens: 1, outputTokens: 1,
    maxInputTokens: 100, maxOutputTokens: 100, usageKnown: true, costCny: 5, costCapCny: 5,
    checkingPageBudget: false,
  })).toBe('cost');
});

test('候选只取正文里相关的实体，不把全库塞进去', () => {
  const entities = [
    { slug: 'people/zhang-san', sourceId: 'vault', type: 'person', title: '张三', aliases: ['张老师'] },
    { slug: 'companies/xinghe', sourceId: 'vault', type: 'company', title: '星河公司', aliases: [] },
    { slug: 'concepts/system', sourceId: 'vault', type: 'concept', title: '系统', aliases: [] },
    { slug: 'people/other', sourceId: 'other', type: 'person', title: '李四', aliases: [] },
  ];
  const ranked = rankCaptureCandidates('张老师参加了评审。系统只是普通用词。', entities, { sourceId: 'vault' });
  expect(ranked.map(item => item.slug)).toEqual(['people/zhang-san', 'concepts/system']);
  expect(ranked[0]).toMatchObject({ type: 'person', title: '张三', aliases: ['张老师'] });
});

test('任务详情能看到页面、分块、Token、费用和剩余资料', () => {
  const view = new TaskProgressAdapter('dream_full').view;
  const next = finishTaskProgress(view, 'completed', {
    phases: [{
      phase: 'capture_entities',
      status: 'ok',
      details: {
        pages_processed: 2,
        chunks_processed: 3,
        input_tokens: 11,
        output_tokens: 4,
        cost_cny: 1.25,
        cost_cap_cny: 5,
        pages_remaining: 8,
      },
    }],
  }, null);
  const metrics = next.metrics.map(metric => [metric.label, metric.value]);
  expect(metrics).toContainEqual(['已处理页面', 2]);
  expect(metrics).toContainEqual(['已处理分块', 3]);
  expect(metrics).toContainEqual(['输入 Token', 11]);
  expect(metrics).toContainEqual(['输出 Token', 4]);
  expect(metrics).toContainEqual(['当前费用', 1.25]);
  expect(metrics).toContainEqual(['费用上限', 5]);
  expect(metrics).toContainEqual(['剩余页面', 8]);
});
