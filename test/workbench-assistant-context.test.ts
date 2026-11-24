import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine';
import type { ChatResult } from '../src/core/ai/gateway';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import type { WorkbenchMessage } from '../shared/workbench';

function user(text: string): WorkbenchMessage {
  return { id: 'user-1', role: 'user', text, createdAt: '2026-11-21T00:00:00.000Z', status: 'complete' };
}

function modelAnswer(text: string): ChatResult {
  return {
    text, model: 'local', providerId: 'test', stopReason: 'end',
    blocks: [{ type: 'text', text }],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}

test('知识库检索或读页失败时，这次对话仍回答，停止生成仍会停', async () => {
  const notes: string[] = [];
  let answered = false;
  const answer = knowledgeWorkbenchAnswer({ getPage: async () => { throw new Error('读取页面失败'); } } as unknown as BrainEngine, {
    search: async () => ({
      results: [{ source_id: 'default', slug: 'projects/demo', title: '示例', type: 'project', snippet: '原文', score: 1, locator: null, page_id: 1, chunk_id: 1 }],
      mode: 'semantic', query: '项目进展', limit: 1, result_count: 1, vector_enabled: false,
    }),
    answer: async () => { answered = true; return modelAnswer('按已有对话回答'); },
    recall: async () => { throw new Error('记忆读取失败'); },
  });
  const result = await answer({
    messages: [user('项目进展怎么样')], model: 'local', knowledge: true, sourceId: 'default', signal: new AbortController().signal,
    progress: () => {}, onContext: note => notes.push(note),
  });
  expect(answered).toBe(true);
  expect(result.text).toBe('按已有对话回答');
  expect(notes.join('')).toContain('没能检索知识库');

  let answeredAfterStop = false;
  const stopping = knowledgeWorkbenchAnswer({} as BrainEngine, {
    search: async () => { throw Object.assign(new Error('已停止'), { name: 'AbortError' }); },
    answer: async () => { answeredAfterStop = true; return modelAnswer('不应回答'); },
  });
  await expect(stopping({
    messages: [user('项目进展怎么样')], model: 'local', knowledge: true, signal: new AbortController().signal, progress: () => {},
  })).rejects.toThrow('已停止');
  expect(answeredAfterStop).toBe(false);
});
