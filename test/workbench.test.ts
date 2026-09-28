import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchService, conversationContext } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-workbench-test-'));
test('multi-turn conversation sends prior user and assistant messages and persists across restart', async () => {
  const dir = root(); const seen: any[] = [];
  const service = new WorkbenchService(new WorkbenchStore(dir), () => [{ id: 'ollama:local', name: '本地' }], async input => { seen.push(input.messages); return { text: '记住了：蓝色', model: 'ollama:local', citations: [] }; });
  const thread = service.create({ model: 'ollama:local', knowledge: true });
  service.send(thread.id, { text: '我喜欢蓝色' }); await service.settled(thread.id);
  service.send(thread.id, { text: '我喜欢什么颜色？' }); await service.settled(thread.id);
  expect(seen[1].map((m: any) => m.text)).toEqual(['我喜欢蓝色', '记住了：蓝色', '我喜欢什么颜色？']);
  expect(new WorkbenchStore(dir).get(thread.id).messages.length).toBe(4);
});
test('conversations do not leak history, cancellation ignores a late answer and retry is explicit', async () => {
  let finish!: (v: any) => void;
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], () => new Promise(resolve => { finish = resolve; }));
  const one = service.create({}); const two = service.create({});
  service.send(one.id, { text: '保留的消息' }); await Promise.resolve();
  expect(service.get(two.id).messages).toHaveLength(0);
  service.cancel(one.id); finish({ text: '不应出现的迟到答案', model: 'ollama:local', citations: [] }); await service.settled(one.id);
  expect(service.get(one.id).messages.at(-1)?.status).toBe('cancelled');
  expect(service.get(one.id).messages.at(-1)?.text).toBe('');
});
test('failed response remains visible and is not replayed as valid context', async () => {
  const service = new WorkbenchService(new WorkbenchStore(root()), () => [{ id: 'ollama:local', name: '本地' }], async () => { throw new Error('平台鉴权失败'); });
  const thread = service.create({}); service.send(thread.id, { text: '你好' }); await service.settled(thread.id);
  expect(service.get(thread.id).messages.at(-1)?.error).toContain('鉴权失败');
  expect(conversationContext(service.get(thread.id).messages).map(m => m.role)).toEqual(['user']);
  expect(() => service.send(thread.id, { text: '未知', model: 'unconfigured:bad' })).toThrow();
  expect(() => service.get('../config')).toThrow();
});

test('retry replaces only the last reply and startup exposes interrupted generation', async () => {
  const store = new WorkbenchStore(root()); let calls = 0;
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地' }], async () => {
    if (!calls++) throw new Error('临时错误');
    return { text: '重试成功', model: 'ollama:local', citations: [] };
  });
  const thread = service.create({}); service.send(thread.id, { text: '保留这个问题' }); await service.settled(thread.id);
  service.send(thread.id, { retry: true }); await service.settled(thread.id);
  const saved = store.get(thread.id);
  expect(saved.messages.map(m => m.text)).toEqual(['保留这个问题', '重试成功']);
  saved.messages[1].status = 'running'; store.save(saved);
  const restored = new WorkbenchService(store, () => [], async () => { throw new Error('不应调用'); });
  expect(restored.get(thread.id).messages[1].error).toContain('中断');
});
