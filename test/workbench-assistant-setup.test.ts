import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

test('改两次同一个助手草稿，重开后说可以，按最新配置只创建一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-assistant-setup-'));
  const work = join(root, 'main-directory');
  mkdirSync(work);
  const store = new WorkbenchStore(join(root, 'sessions'));
  const agents = new WorkbenchAgentStore(store);
  const main = agents.get('main');
  agents.update('main', { revision: main.revision, workspaceDirectory: work });
  const drafted: string[] = [];
  let validations = 0;
  const config = {
    draft: async ({ text }: { text: string }) => {
      drafted.push(text);
      return { name: drafted.length === 1 ? '项目管理' : '外资外事处', description: '跟进项目的进展、待办和下一步。', systemPrompt: '按资料回答并注明出处。', workflow: '核对进展并整理下一步。', workspaceDirectory: work };
    },
    validate: async () => { validations++; },
  };
  const service = () => new WorkbenchService(new WorkbenchStore(store.root), () => [{ id: 'local', name: '本地' }],
    async () => { throw new Error('创建草稿和确认不应访问普通知识问答'); }, undefined, undefined, undefined, config);
  let running = service();
  const thread = running.create({ knowledge: true });
  const send = async (text: string) => {
    running.send(thread.id, { text });
    await running.settled(thread.id);
    return running.get(thread.id).messages.at(-1)!;
  };
  const initial = await send('创建一个助手，名字叫项目管理，用来管理我负责的几个项目。');
  expect(initial.text).toContain('项目管理');
  expect(initial.text).not.toContain(work);
  await send('先见外资外事处的项目管理岗吧，名称叫外资外事处就行');
  expect((await send('名称换下，叫外资外贸综合场景')).text).toContain('外资外贸综合场景');
  expect(agents.list()).toHaveLength(1);
  running = service();
  const created = await send('可以');
  expect(created.status).toBe('complete');
  expect(created.text).toContain('已创建「外资外贸综合场景」');
  expect(created.toolCalls?.filter(call => call.name === 'assistant_create' && call.status === 'complete')).toHaveLength(1);
  expect(agents.list()).toHaveLength(2);
  expect(agents.list().find(agent => agent.name === '外资外贸综合场景')?.workspaceDirectory).toBeUndefined();
  await send('直接创建。');
  expect(agents.list()).toHaveLength(2);
  expect(drafted).toHaveLength(2);
  expect(validations).toBe(1);
});

test('匹配到真实保存的助手回执时恢复创建，重试不再次写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-create-recovery-'));
  const store = new WorkbenchStore(root);
  const agents = new WorkbenchAgentStore(store);
  let id: string;
  let validations = 0;
  const hooks = {
    draft: async () => ({ name: '报销项目', description: '核对发票' }),
    validate: async (draft: Record<string, unknown>) => { validations++; agents.create(draft, id); throw new Error('模拟创建写入后进程中断'); },
  };
  const reopen = () => new WorkbenchService(new WorkbenchStore(root), () => [{ id: 'local', name: '本地' }],
    async () => { throw new Error('unexpected normal answer'); }, undefined, undefined, undefined, hooks);
  const service = reopen();
  const thread = service.create({ knowledge: false });
  service.send(thread.id, { text: '创建一个助手，名字叫报销项目，负责核对发票' });
  await service.settled(thread.id);
  id = service.get(thread.id).pending!.draftId!;
  service.send(thread.id, { text: '可以' });
  await service.settled(thread.id);
  expect(service.get(thread.id).messages.at(-1)?.toolCalls?.map(call => [call.status, call.error])).toEqual([['error', '模拟创建写入后进程中断']]);
  const restarted = reopen();
  restarted.send(thread.id, { retry: true });
  await restarted.settled(thread.id);
  expect(restarted.get(thread.id).messages.at(-1)?.text).toContain('已创建「报销项目」');
  expect(agents.list().filter(agent => agent.id === id)).toHaveLength(1);
  expect(validations).toBe(1);
});

test('工作目录只来自当前创建要求，插入无关对话后的可以不会创建', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-create-scope-'));
  const work = join(root, 'workspace');
  const other = join(root, 'other');
  mkdirSync(work); mkdirSync(other);
  const store = new WorkbenchStore(root);
  const agents = new WorkbenchAgentStore(store);
  const hooks = {
    draft: async () => ({ name: '项目管理', description: '跟进项目', workspaceDirectory: other, readDirectories: [other], sourceIds: ['arbitrary'] }),
    validate: async () => {},
  };
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地' }],
    async () => ({ text: '普通回答', model: 'local', citations: [] }), undefined, undefined, undefined, hooks);
  const thread = service.create({ knowledge: true });
  const send = async (text: string) => { service.send(thread.id, { text }); await service.settled(thread.id); };
  await send(`创建一个项目助手，名称叫项目管理，工作目录设为 "${work}"`);
  expect(service.get(thread.id).pending?.draft?.workspaceDirectory).toBe(work);
  expect(service.get(thread.id).pending?.draft?.readDirectories).toEqual([]);
  await send('今天深圳天气如何？');
  await send('可以');
  expect(service.get(thread.id).messages.at(-1)?.text).toBe('普通回答');
  expect(agents.list()).toHaveLength(1);
});

test('升级后从旧失败对话重建草稿，遇到重名可以改名后继续', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-legacy-assistant-setup-'));
  const store = new WorkbenchStore(root);
  const agents = new WorkbenchAgentStore(store);
  const legacy = new WorkbenchService(store, () => [{ id: 'local', name: '本地' }],
    async () => ({ text: '旧草稿里自行填了工作目录 E:\\外资外事处', model: 'local', citations: [] }));
  const thread = legacy.create({ knowledge: true });
  legacy.send(thread.id, { text: '创建一个助手，名字叫项目管理，负责跟进进度' });
  await legacy.settled(thread.id);
  expect(legacy.get(thread.id).pending?.kind).toBe('assistant-create');
  agents.create({ name: '项目管理' });
  const service = new WorkbenchService(new WorkbenchStore(root), () => [{ id: 'local', name: '本地' }],
    async () => { throw new Error('unexpected normal answer'); }, undefined, undefined, undefined, {
      draft: async ({ text }) => {
        expect(text).not.toContain('E:\\外资外事处');
        return { name: '项目管理', description: '负责跟进进度' };
      },
      validate: async () => {},
    });
  const send = async (text: string) => {
    service.send(thread.id, { text });
    await service.settled(thread.id);
    return service.get(thread.id).messages.at(-1)!;
  };
  expect((await send('直接创建')).text).toContain('未设置，可创建后再选择');
  expect(agents.list()).toHaveLength(2);
  const failed = await send('可以');
  expect(failed.status).toBe('error');
  expect(failed.toolCalls).toHaveLength(1);
  expect(failed.toolCalls?.[0]?.error).toContain('同名');
  expect((await send('名称改为项目进度')).text).toContain('创建草稿 · 项目进度');
  expect((await send('可以，就按这个来')).text).toContain('已创建「项目进度」');
  expect(agents.list().find(agent => agent.name === '项目进度')?.workspaceDirectory).toBeUndefined();
});
