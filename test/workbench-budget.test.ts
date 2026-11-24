import { expect, test } from 'bun:test';
import { contextBudget, estimateTokens, planContext, summaryInputBudget } from '../src/product/workbench/context';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { defaultAssistant } from '../shared/workbench';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const message = (id: string, text: string) => ({ id, text, role: 'user' as const, status: 'complete' as const, createdAt: '' });
test('system prompt and retrieval reserve reduce the history budget', () => {
  const messages = [message('old', '旧'.repeat(1400)), message('new', '新'.repeat(400))];
  const planned = planContext(messages, defaultAssistant().context, { contextWindow: 4096, systemPrompt: '系统'.repeat(600), additionalTokens: 200 });
  expect(planned.older.map(item => item.id)).toEqual(['old']);
  expect(planned.recent.map(item => item.id)).toEqual(['new']);
});
test('retrieved pages share the request budget and retain exact source citations', async () => {
  let sent: any;
  const answer = knowledgeWorkbenchAnswer({ getPage: async () => ({ compiled_truth: '资料'.repeat(6000), timeline: '' }) } as any, {
    search: async () => ({ results: Array.from({ length: 6 }, (_, i) => ({ source_id: 'a', slug: `page-${i}`, title: `资料${i}`, snippet: '摘要' })) } as any),
    answer: async input => { sent = input; return { text: '回答 [1]', model: input.model, stopReason: 'end' } as any; },
  });
  const result = await answer({ messages: [message('new', '问题')], model: 'm', knowledge: true, contextWindow: 4096, contextThreshold: .8, signal: new AbortController().signal, progress: () => {} });
  expect(estimateTokens(sent.system) + estimateTokens(sent.messages[0].content) + 8).toBeLessThanOrEqual(contextBudget(4096, .8));
  expect(result.citations.length).toBeGreaterThan(0);
  expect(result.citations[0].sourceId).toBe('a');
  expect(sent.system).toContain('节选');
});
test('oversized system plus latest question fails before any model request', async () => {
  let calls = 0;
  const answer = knowledgeWorkbenchAnswer({} as any, { search: async () => ({ results: [] } as any), answer: async () => { calls++; return {} as any; } });
  await expect(answer({ messages: [message('new', '问题'.repeat(1500))], systemPrompt: '提示'.repeat(800), model: 'm', knowledge: false, contextWindow: 4096, signal: new AbortController().signal, progress: () => {} })).rejects.toThrow('上下文');
  expect(calls).toBe(0);
});

test('continuation stops before growing answer exceeds the next request budget', async () => {
  let calls = 0;
  const answer = knowledgeWorkbenchAnswer({} as any, { search: async () => ({ results: [] } as any), answer: async input => { calls++; return { text: '回答'.repeat(2000), model: input.model, stopReason: 'length' } as any; } });
  const result = await answer({ messages: [message('new', '问题')], model: 'm', knowledge: false, contextWindow: 4096, signal: new AbortController().signal, progress: () => {} });
  expect(calls).toBe(2);
  expect(result.text).toBe('回答'.repeat(2000));
  expect(result.stopReason).toBe('length');
});

test('模型续写中断时，重开保留已写正文但不能显示回答完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-incomplete-answer-'));
  const store = new WorkbenchStore(dir);
  const models = () => [{ id: 'small', name: '小模型', contextWindow: 4096 }];
  const service = new WorkbenchService(store, models, async () => ({
    text: '第一节已写好，后续章节尚未生成。', model: 'small',
    citations: [{ sourceId: 'a', slug: 'project', title: '项目资料', snippet: '原文' }], stopReason: 'length',
  }));
  const thread = service.create({});
  service.send(thread.id, { text: '给我写全文' });
  await service.settled(thread.id);
  const reply = new WorkbenchStore(dir).get(thread.id).messages.at(-1)!;
  expect(reply.status).toBe('error');
  expect(reply.errorCode).toBe('answer_incomplete');
  expect(reply.text).toBe('第一节已写好，后续章节尚未生成。');
  expect(reply.citations?.[0]?.slug).toBe('project');
});

test('summary batches respect a small summary model window and include the end of a large attachment', async () => {
  const store = new WorkbenchStore(mkdtempSync(join(tmpdir(), 'pmbrain-summary-budget-')));
  const transcripts: string[] = [];
  const service = new WorkbenchService(store, () => [{ id: 'small', name: '小模型', contextWindow: 4096 }], async input => ({ text: '回答', model: input.model, citations: [] }), async input => {
    expect(input.contextWindow).toBe(4096);
    expect(estimateTokens(input.prior) + estimateTokens(input.transcript)).toBeLessThanOrEqual(summaryInputBudget(4096));
    transcripts.push(input.transcript); return '保留摘要';
  });
  const settings = defaultAssistant(); settings.context.maxMessages = 2; store.saveAssistant(settings);
  const thread = service.create({ knowledge: false });
  thread.messages.push(message('old', '旧'.repeat(15000) + '末尾决定'), { ...message('answer', '答复'), role: 'assistant' }); store.save(thread);
  service.send(thread.id, { text: '新的问题' }); await service.settled(thread.id);
  expect(transcripts.length).toBeGreaterThan(1);
  expect(transcripts.join('')).toContain('末尾决定');
  expect(store.get(thread.id).messages.at(-1)?.status).toBe('complete');
});
