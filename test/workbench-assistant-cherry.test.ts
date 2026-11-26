import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conversationMarkdown, quotedDraft, translationFollowUp, usageLabel } from '../src/product/workbench/conversation-actions';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { defaultAssistant, normalizeAssistant } from '../shared/workbench';

test('导出、翻译、引用和用量都按对话里能看到的内容处理', () => {
  const markdown = conversationMarkdown({
    assistantName: '周报助手',
    messages: [
      { role: 'user', text: '写本周周报', attachments: [{ name: '进展.txt' }] },
      { role: 'assistant', text: '本周完成了两项', citations: [{ sourceId: 'default', slug: 'weekly', title: '周报材料', snippet: '两项' }] },
    ],
  });
  expect(markdown.startsWith('# 周报助手 · 对话记录')).toBe(true);
  expect(markdown).toContain('## 你');
  expect(markdown).toContain('附件：进展.txt');
  expect(markdown).toContain('[1] 周报材料 · default / weekly');
  expect(translationFollowUp('本周完成了两项')).toContain('翻译成英文');
  expect(translationFollowUp('Weekly status is ready')).toContain('翻译成中文');
  expect(translationFollowUp('本周完成了两项')).toContain('不要新增事实');
  expect(quotedDraft('第一行\n第二行')).toBe('> 第一行\n> 第二行\n\n');
  expect(quotedDraft(` ${'长'.repeat(2100)} `).length).toBeLessThanOrEqual(2000 + 4);
  expect(usageLabel(undefined)).toBeNull();
  expect(usageLabel([{ elapsedMs: 1 } as { inputTokens?: number }])).toBeNull();
  expect(usageLabel([{ inputTokens: 12, outputTokens: 7 }, { outputTokens: 3 }])).toBe('本次输入 12 / 输出 10 Token');
});

test('没填核采样时不发给模型，填了越界值会拒绝', async () => {
  expect(defaultAssistant().topP).toBeUndefined();
  expect(normalizeAssistant(defaultAssistant()).topP).toBeNull();
  expect(normalizeAssistant({ ...defaultAssistant(), topP: 0.9, temperature: 0.2 }).topP).toBe(0.9);
  expect(() => normalizeAssistant({ ...defaultAssistant(), topP: 1.2 })).toThrow('核采样');
  const seen: Array<{ temperature?: number; topP?: number }> = [];
  const answer = knowledgeWorkbenchAnswer({} as any, {
    search: async () => ({ results: [] } as any),
    answer: async input => { seen.push({ temperature: input.temperature, topP: input.topP }); return { text: '好', model: 'm', stopReason: 'end' } as any; },
  });
  const signal = new AbortController().signal;
  const messages = [{ id: '1', role: 'user' as const, text: '问', status: 'complete' as const, createdAt: '' }];
  await answer({ model: 'm', knowledge: false, temperature: 0.2, topP: 0.8, signal, progress: () => {}, messages });
  await answer({ model: 'm', knowledge: false, temperature: 0.2, signal, progress: () => {}, messages });
  expect(seen[0]).toEqual({ temperature: 0.2, topP: 0.8 });
  expect(seen[1]).toEqual({ temperature: 0.2, topP: undefined });
});

test('对话里能看到翻译、引用、导出和核采样', () => {
  const root = join(import.meta.dir, '..');
  const message = readFileSync(join(root, 'admin/src/workbench/Message.tsx'), 'utf8');
  const workbench = readFileSync(join(root, 'admin/src/workbench/Workbench.tsx'), 'utf8');
  const settings = readFileSync(join(root, 'admin/src/workbench/AssistantSettings.tsx'), 'utf8');
  const cards = readFileSync(join(root, 'admin/src/workbench/AgentCards.tsx'), 'utf8');
  expect(message).toContain('翻译');
  expect(message).toContain('引用');
  expect(message).toContain('usageLabel');
  expect(workbench).toContain('导出 Markdown');
  expect(workbench).toContain('translationFollowUp');
  expect(workbench).toContain('quotedDraft');
  expect(settings).toContain('aria-label="核采样"');
  expect(cards).toContain('查看对话');
  expect(cards).toContain('assistant_collaborate');
});
