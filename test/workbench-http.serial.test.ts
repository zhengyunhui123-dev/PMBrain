import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { configureGateway, resetGateway } from '../src/core/ai/gateway';
import { knowledgeWorkbenchAnswer, registerWorkbenchRoutes } from '../src/product/workbench/routes';

test('knowledge evidence reads the exact Source and preserves all conversation turns', async () => {
  const reads: unknown[] = []; let sent: any;
  const answer = knowledgeWorkbenchAnswer({ getPage: async (slug: string, opts: unknown) => { reads.push([slug, opts]); return { compiled_truth: '项目正式预算为十万元', timeline: '' }; } } as any, {
    search: async () => ({ results: [{ source_id: 'source-a', slug: 'project', title: '项目资料', snippet: '预算' }] } as any),
    answer: async input => { sent = input; return { text: '十万元 [1]', model: input.model } as any; },
  });
  const result = await answer({ model: 'service-test:chat', knowledge: true, signal: new AbortController().signal, progress: () => {}, messages: [{ id: '1', role: 'user', text: '预算是多少', status: 'complete', createdAt: '' }] });
  expect(reads).toEqual([['project', { sourceId: 'source-a' }]]);
  expect(sent.system).toContain('十万元'); expect(sent.messages[0].content).toBe('预算是多少');
  expect(result.citations[0].sourceId).toBe('source-a');
});
test('HTTP workbench sends two real gateway requests with history and persists the answer', async () => {
  const requests: any[] = [];
  const modelServer = Bun.serve({ port: 0, async fetch(req) {
    const input = await req.json() as any; requests.push(input);
    return Response.json({ id: 'test', object: 'chat.completion', created: 1, model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: '你喜欢蓝色' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
  } });
  const app = express();
  registerWorkbenchRoutes(app, (_req, _res, next) => next(), {} as any, { engine: 'pglite', chat_model: 'service-test:local' } as any, { storageRoot: mkdtempSync(join(tmpdir(), 'pmbrain-http-test-')) });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json() as Promise<any>;
  };
  try {
    configureGateway({ generative_enabled: true, chat_model: 'service-test:local', env: {}, base_urls: { 'service-test': `${modelServer.url}v1` } });
    const thread = await request('/conversations', { knowledge: false });
    for (const text of ['我喜欢蓝色', '我喜欢什么颜色？']) {
      await request(`/conversations/${thread.id}/messages`, { text, knowledge: false });
      let result: any;
      for (let i = 0; i < 100; i++) { result = await request(`/conversations/${thread.id}`); if (result.messages.at(-1).status !== 'running') break; await Bun.sleep(10); }
      expect(result.messages.at(-1).status).toBe('complete');
    }
    expect(requests[1].messages.filter((m: any) => m.role !== 'system').map((m: any) => m.content)).toEqual(['我喜欢蓝色', '你喜欢蓝色', '我喜欢什么颜色？']);
  } finally { resetGateway(); modelServer.stop(true); server.close(); }
});
