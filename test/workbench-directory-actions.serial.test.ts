import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureGateway, resetGateway, __setChatTransportForTests, chat, toolLoop, type ChatResult } from '../src/core/ai/gateway';
import { agentHandlers, agentTools, type WorkbenchAgentTools } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { buildTurnEnvironment } from '../src/product/workbench/agent-runtime';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
const answer = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], model: 'service-directory:chat', providerId: 'service-directory', usage, stopReason: 'end' });
const call = (name: string, input: unknown): ChatResult => ({ ...answer(''), blocks: [{ type: 'tool-call', toolName: name, input, toolCallId: name }], stopReason: 'tool_calls' });
beforeEach(() => configureGateway({ generative_enabled: true, chat_model: 'service-directory:chat', env: {} }));
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-directory-'));
  const output = join(root, 'output'); mkdirSync(output);
  const store = new WorkbenchStore(join(root, 'workbench'));
  const agents = new WorkbenchAgentStore(store);
  const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: output }] : [{ id: 'default' }], getConfig: async () => null, getPage: async () => null } as any;
  const context: WorkbenchAgentTools = { store: agents, engine, config: () => ({ engine: 'pglite' }) };
  const open = () => new WorkbenchService(store, () => [{ id: 'service-directory:chat', name: '本地测试', contextWindow: 32768 }], knowledgeWorkbenchAnswer(engine, { search: async () => ({ results: [] } as any), answer: chat, loop: toolLoop }, undefined, context));
  return { root, output, store, agents, context, open };
}

test('目录工具实际创建并读回，重复使用原目录，拒绝越界、文件冲突及链接', async () => {
  const f = fixture();
  const readOnly = join(f.root, 'read-only'); mkdirSync(readOnly);
  const agent = f.agents.create({ workspaceDirectory: f.output, name: '项目助手', readDirectories: [readOnly] });
  const handlers = agentHandlers(f.context, { agent, userText: '新建一个项目文件夹', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true });
  const tool = handlers.get('local_mkdir'); expect(tool).toBeDefined();
  const execute = (input: unknown) => tool!.execute(input, new AbortController().signal);
  const created = await execute({ name: '项目甲' }) as any;
  expect(created.created).toBe(true); expect(created.path).toBe(join(f.output, '项目甲'));
  expect(statSync(created.path).isDirectory()).toBe(true);
  expect((await execute({ name: '项目甲' }) as any).created).toBe(false);
  for (const name of ['../越界', '..', 'a/b', 'a\\b', 'CON', '结尾.']) await expect(execute({ name })).rejects.toThrow();
  const selected = agentHandlers(f.context, { agent, userText: `在 ${readOnly} 新建文件夹`, conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true });
  const insideRead = await selected.get('local_mkdir')!.execute({ directory: readOnly, name: '授权新建' }, new AbortController().signal) as any;
  expect(insideRead.created).toBe(true);
  expect(statSync(join(readOnly, '授权新建')).isDirectory()).toBe(true);
  const outside = join(f.root, 'outside-root');
  await expect(execute({ directory: outside, name: '越权写入' })).rejects.toThrow();
  expect(existsSync(join(outside, '越权写入'))).toBe(false);
  writeFileSync(join(f.output, '已有文件'), '原文');
  await expect(execute({ name: '已有文件' })).rejects.toThrow();
  expect(readFileSync(join(f.output, '已有文件'), 'utf8')).toBe('原文');
  symlinkSync(readOnly, join(f.output, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(execute({ directory: join(f.output, 'outside'), name: '越界' })).rejects.toThrow();
  expect(existsSync(join(readOnly, '越界'))).toBe(false);
});

test('旧报销任务先建日期目录，不生成报销单；重启后续做写进该目录', async () => {
  const f = fixture(); let service = f.open();
  const agent = f.agents.create({ workspaceDirectory: f.output, name: '报销助手', workflow: '生成报销单并保存 Word', systemPrompt: '整理报销材料，中文命名', deliveryFormat: 'markdown' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const seeded = service.get(conversation.id);
  seeded.task = { id: 'expense-task', goal: '整理成都出差报销', constraints: ['保留中文文件名'], updatedAt: '' };
  seeded.messages.push({ id: 'previous', role: 'user', text: '这次是成都出差，文件夹按成都出差加日期命名', status: 'complete', createdAt: '' });
  f.store.save(seeded);
  let requests = 0;
  __setChatTransportForTests(async options => {
    requests += 1;
    expect(options.tools?.map(tool => tool.name)).toContain('local_mkdir');
    expect(options.tools?.map(tool => tool.name)).not.toContain('artifact_save');
    expect(options.system).toContain('只执行用户当前要求的步骤');
    expect(options.system).toContain('<workflow>');
    return requests === 1 ? call('local_mkdir', { name: '成都出差10.8-10.16' }) : answer('报销单已生成。');
  });
  service.send(conversation.id, { text: '先创建10月8号到16号的文件夹' });
  await service.settled(conversation.id);
  const folder = join(f.output, '成都出差10.8-10.16');
  const reply = service.get(conversation.id).messages.at(-1)!;
  expect(reply.status).toBe('complete'); expect(reply.text).toContain(folder);
  expect(reply.text).not.toContain('报销单已生成'); expect(f.agents.artifacts()).toHaveLength(0);
  expect(statSync(folder).isDirectory()).toBe(true);
  expect((service.get(conversation.id).task as any)?.directory?.path).toBe(folder);
  service = f.open(); requests = 0;
  __setChatTransportForTests(async options => {
    requests += 1; expect(options.system).toContain(folder);
    return requests === 1 ? call('artifact_save', { title: '报销材料清单', content: '# 待处理\n等待用户提供票据。', format: 'markdown' }) : answer('材料清单已保存。');
  });
  service.send(conversation.id, { text: '生成待补票据清单，保存到刚才的文件夹' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(existsSync(join(folder, '报销材料清单.md'))).toBe(true);
  expect(existsSync(join(f.output, '报销材料清单.md'))).toBe(false);
  expect(f.agents.artifacts()).toHaveLength(1);
});

test('目录请求不能越权保存报告，没有成功目录回执不接受模型的成功声明', async () => {
  const f = fixture(); const agent = f.agents.create({ workspaceDirectory: f.output, name: '文件助手' });
  expect(agentTools(agent, '先新建一个资料目录', f.context).map(tool => tool.name)).not.toContain('artifact_save');
  const handler = agentHandlers(f.context, { agent, userText: '先新建一个资料目录', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true });
  await expect(handler.get('artifact_save')!.execute({ title: '报告', content: '不得写入' }, new AbortController().signal)).rejects.toThrow();
  let requests = 0;
  __setChatTransportForTests(async () => { requests++; return answer('文件夹已经建好了。'); });
  const service = f.open(); const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '创建10月8号到16号的文件夹' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('error');
  expect(service.get(conversation.id).messages.at(-1)?.error).toContain('目录');
  expect(f.agents.artifacts()).toHaveLength(0);
  expect(requests).toBe(2);
});

test('跨周短指令带入当轮日期，错误日期后的纠正包含真实失败回执', async () => {
  const f = fixture(); const agent = f.agents.create({ workspaceDirectory: f.output, name: '报销助手' });
  const environment = buildTurnEnvironment({ agent, messages: [], timeZone: 'Asia/Shanghai' });
  const oldName = `${environment.previousWeek.start}至${environment.previousWeek.end}报销`;
  const currentName = `${environment.week.start}至${environment.week.end}报销`;
  let requests = 0;
  __setChatTransportForTests(async options => {
    requests++;
    const latest = JSON.stringify(options.messages.at(-1)?.content);
    if (requests === 1) {
      expect(latest).toContain(environment.today);
      expect(latest).toContain(`${environment.week.start} 至 ${environment.week.end}`);
      return call('local_mkdir', { name: oldName });
    }
    if (requests === 2) return answer(`根据以前的成功回执，已创建 ${oldName}`);
    if (requests === 3) {
      expect(latest).toContain('本轮失败回执');
      expect(latest).toContain(`本周是 ${environment.week.start} 至 ${environment.week.end}`);
      return call('local_mkdir', { name: currentName });
    }
    return answer('已完成');
  });
  const service = f.open(); const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '新建一个本周报销的文件夹', timeZone: 'Asia/Shanghai' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.error).toBeUndefined();
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(service.get(conversation.id).messages.at(-1)?.text).toContain(currentName);
  expect(existsSync(join(f.output, oldName))).toBe(false);
  expect(existsSync(join(f.output, currentName))).toBe(true);
  expect(requests).toBe(4);
});

test.each(['已在指定目录下创建本周报销文件夹。', '搞定了。'])('目录步骤以实际回执完成，不靠成功措辞猜测：%s', async text => {
  const f = fixture(); const agent = f.agents.create({ workspaceDirectory: f.output, name: '文件助手' }); let requests = 0;
  __setChatTransportForTests(async () => ++requests === 1 ? answer(text) : requests === 2 ? call('local_mkdir', { name: '验收目录' }) : answer('搞定了。'));
  const service = f.open(); const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '新建一个验收目录' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(existsSync(join(f.output, '验收目录'))).toBe(true);
  expect(service.get(conversation.id).messages.at(-1)?.text).toBe(`已创建文件夹：${join(f.output, '验收目录')}`);
});

test('日期范围不能误拆成单日目录，明确逐日时才允许', async () => {
  const f = fixture(); const agent = f.agents.create({ workspaceDirectory: f.output, name: '出差助手' });
  const context = { agent, userText: '先创建10月8号到16号的文件夹', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true };
  const tool = agentHandlers(f.context, context).get('local_mkdir')!;
  await expect(tool.execute({ name: '出差10月8日' }, new AbortController().signal)).rejects.toThrow('起止日期');
  expect(existsSync(join(f.output, '出差10月8日'))).toBe(false);
  const result = await tool.execute({ name: '出差10.8-10.16' }, new AbortController().signal) as any;
  expect(statSync(result.path).isDirectory()).toBe(true);
  const daily = agentHandlers(f.context, { ...context, userText: '逐日创建10月8号到16号的文件夹' }).get('local_mkdir')!;
  const day = await daily.execute({ name: '10月8日' }, new AbortController().signal) as any;
  expect(statSync(day.path).isDirectory()).toBe(true);
});

test('同一请求先建目录再保存文件时，也使用刚创建的目录', async () => {
  const f = fixture(); const agent = f.agents.create({ workspaceDirectory: f.output, name: '项目助手', deliveryFormat: 'markdown' });
  let requests = 0;
  __setChatTransportForTests(async () => ++requests === 1 ? call('local_mkdir', { name: '项目甲' }) : requests === 2 ? call('artifact_save', { title: '待办', content: '# 待办\n整理资料。' }) : answer('已完成。'));
  const service = f.open(); const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '创建项目甲文件夹，然后生成待办清单并保存' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(existsSync(join(f.output, '项目甲', '待办.md'))).toBe(true);
  expect(existsSync(join(f.output, '待办.md'))).toBe(false);
});

test('创建成功后模型失败，重试沿用同一目录并再次读回', async () => {
  const f = fixture(); const agent = f.agents.create({ workspaceDirectory: f.output, name: '项目助手' });
  let requests = 0;
  __setChatTransportForTests(async () => { if (++requests === 1) return call('local_mkdir', { name: '项目乙' }); throw new Error('模拟目录已建好后的模型失败'); });
  const service = f.open(); const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '创建项目乙文件夹' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('error');
  expect(statSync(join(f.output, '项目乙')).isDirectory()).toBe(true);
  requests = 0;
  __setChatTransportForTests(async () => ++requests === 1 ? call('local_mkdir', { name: '项目乙' }) : answer('已完成。'));
  service.send(conversation.id, { retry: true }); await service.settled(conversation.id);
  const reply = service.get(conversation.id).messages.at(-1)!;
  expect(reply.status).toBe('complete'); expect(reply.text).toContain('继续使用');
  expect(reply.text).toContain(join(f.output, '项目乙')); expect(f.agents.artifacts()).toHaveLength(0);
});
