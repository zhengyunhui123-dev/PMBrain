import { expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorkbenchRoutes } from '../src/product/workbench/routes';

test('数据库探测未返回时，应用状态和普通对话仍可响应', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-availability-'));
  const app = express();
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  registerWorkbenchRoutes(app, (_req, _res, next) => next(), { executeRaw: () => pending } as any,
    { engine: 'pglite', chat_model: 'service-test:chat' } as any, {
      readConfig: () => null, databaseAvailable: () => true, storageRoot: root, answer: async () => ({ text: '普通对话可用', model: 'service-test:chat', citations: [] }),
    });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    expect(await (await fetch(base + '/availability')).json()).toEqual({ serviceReady: true, databaseReady: false });
    expect((await (await fetch(base + '/models')).json() as any).defaultModel).toBe('service-test:chat');
    const conversation = await post('/conversations', { model: 'service-test:chat', knowledge: false });
    await post(`/conversations/${conversation.id}/messages`, { text: '你好', model: 'service-test:chat', knowledge: false });
    await Bun.sleep(30);
    const saved = await (await fetch(base + `/conversations/${conversation.id}`)).json() as any;
    expect(saved.messages.at(-1).text).toBe('普通对话可用');
    const continued = await post(`/conversations/${conversation.id}/messages`, { text: '继续普通对话', model: 'service-test:chat' });
    expect(continued.error).toBeUndefined();
    await Bun.sleep(30);
    const blocked = await post(`/conversations/${conversation.id}/messages`, { text: '查资料', model: 'service-test:chat', knowledge: true });
    expect(blocked.error).toContain('知识库正在准备');
    complete(); await Bun.sleep(20);
    expect((await (await fetch(base + '/availability')).json() as any).databaseReady).toBe(true);
  } finally { complete(); server.close(); rmSync(root, { recursive: true, force: true }); }
});

test('数据库曾经就绪后，慢探测不再把知识库标成未准备', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-availability-ready-'));
  const app = express();
  let hang = false;
  let release: (() => void) | undefined;
  registerWorkbenchRoutes(app, (_req, _res, next) => next(), {
    executeRaw: () => hang ? new Promise(resolve => { release = () => resolve([]); }) : Promise.resolve([]),
  } as any, { engine: 'pglite', chat_model: 'service-test:chat' } as any, {
    readConfig: () => null, databaseAvailable: () => true, storageRoot: root,
    answer: async () => ({ text: '关键词对话可用', model: 'service-test:chat', citations: [] }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    const deadline = Date.now() + 2000;
    let ready = false;
    do {
      ready = ((await (await fetch(base + '/availability')).json()) as any).databaseReady === true;
      if (!ready) await Bun.sleep(20);
    } while (!ready && Date.now() < deadline);
    expect(ready).toBe(true);
    hang = true;
    await fetch(base + '/availability');
    await Bun.sleep(1600);
    expect(((await (await fetch(base + '/availability')).json()) as any).databaseReady).toBe(true);
    const conversation = await post('/conversations', { model: 'service-test:chat', knowledge: true });
    const sent = await post(`/conversations/${conversation.id}/messages`, { text: '导入过程能搜索吗', model: 'service-test:chat', knowledge: true });
    expect(sent.error).toBeUndefined();
  } finally { release?.(); server.close(); rmSync(root, { recursive: true, force: true }); }
});
