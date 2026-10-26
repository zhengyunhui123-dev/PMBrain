import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTurnEnvironment, turnEnvironmentPrompt, validateRelativePeriod } from '../src/product/workbench/agent-runtime';
import { taskRequiresEvidence } from '../src/product/workbench/task-context';
import { WorkbenchStore } from '../src/product/workbench/store';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchService } from '../src/product/workbench/service';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { agentHandlers, agentInstructions, agentTools } from '../src/product/workbench/agent-tools';
import { chat, toolLoop, configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
const answer = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], model: 'service-bot:chat', providerId: 'service-bot', usage, stopReason: 'end' });
const call = (name: string, input: unknown): ChatResult => ({ ...answer(''), blocks: [{ type: 'tool-call', toolName: name, input, toolCallId: name }], stopReason: 'tool_calls' });
const user = (text: string, id = 'user', createdAt = '2026-10-25T01:00:00Z') => ({ id, text, role: 'user' as const, status: 'complete' as const, createdAt });
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-bot-'));
  const library = join(root, 'library'); const work = join(root, 'expenses'); const other = join(root, 'other');
  for (const path of [library, work, other]) mkdirSync(path);
  const store = new WorkbenchStore(join(root, 'state')); const agents = new WorkbenchAgentStore(store);
  const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: library }] : [{ id: 'default' }], getConfig: async () => null, getPage: async () => null } as any;
  const context = { store: agents, engine, config: () => ({ engine: 'pglite' as const }) };
  const open = (recall?: any) => new WorkbenchService(store, () => [{ id: 'service-bot:chat', name: '测试', contextWindow: 32768 }], knowledgeWorkbenchAnswer(engine, { search: async () => ({ results: [] } as any), answer: chat, loop: toolLoop, recall }, undefined, context));
  configureGateway({ generative_enabled: true, chat_model: 'service-bot:chat', env: {} });
  return { root, library, work, other, store, agents, engine, context, open };
}

test('每轮时间来自当前时区，本周周一至周日，跨周和跨年重新计算', () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手' });
  const sunday = buildTurnEnvironment({ agent, messages: [], now: '2026-10-25T15:59:00Z', timeZone: 'Asia/Shanghai' });
  expect(sunday.today).toBe('2026-10-25'); expect(sunday.week).toEqual({ start: '2026-10-19', end: '2026-10-25' });
  const monday = buildTurnEnvironment({ agent, messages: [], now: '2026-10-25T16:01:00Z', timeZone: 'Asia/Shanghai' });
  expect(monday.week).toEqual({ start: '2026-10-26', end: '2026-11-01' });
  const year = buildTurnEnvironment({ agent, messages: [], now: '2027-01-01T01:00:00Z', timeZone: 'Asia/Shanghai' });
  expect(year.week).toEqual({ start: '2026-12-28', end: '2027-01-03' });
  expect(turnEnvironmentPrompt(sunday)).toContain('2026-10-19');
  expect(() => validateRelativePeriod('新建本周报销文件夹', '报销2026-10-13至2026-10-19', sunday)).toThrow('2026-10-19 至 2026-10-25');
  expect(() => validateRelativePeriod('新建本周报销文件夹', '报销2026-10-19至2026-10-25', sunday)).not.toThrow();
});

test('纠正位置和日期不因旧报销目标变成必须引用本期工作事实的报告任务', () => {
  const task = { id: 'old', goal: '按本期资料生成报销报告', constraints: [], updatedAt: '' };
  expect(taskRequiresEvidence('你根据上下文应该创建这里吗？而且本周，不是上周', task)).toBe(false);
  expect(taskRequiresEvidence('现在继续生成本周报告', task)).toBe(true);
});

test('模型选择其他授权目录也不能绕过用户指定位置', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手', readDirectories: [f.work, f.other] });
  const tool = agentHandlers(f.context, { agent, userText: `在 ${f.work} 创建文件夹`, conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true }).get('local_mkdir')!;
  await expect(tool.execute({ directory: f.other, name: '不该创建' }, new AbortController().signal)).rejects.toThrow('不一致');
  expect(existsSync(join(f.other, '不该创建'))).toBe(false);
});

test('目录选择只来自用户和助手配置，不从助手旧回复或知识来源猜测', () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手', readDirectories: [f.work] });
  expect(buildTurnEnvironment({ agent, messages: [user('新建本周文件夹')] }).workspace).toBeUndefined();
  const old = { ...user(`已经建在 ${f.library}`), role: 'assistant' as const };
  const environment = buildTurnEnvironment({ agent, messages: [old, user(`报销资料在 ${f.work}`, 'morning'), user('新建本周文件夹', 'now')] });
  expect(environment.workspace?.path).toBe(realpathSync(f.work));
  expect(environment.workspace?.messageId).toBe('morning');
  expect(buildTurnEnvironment({ agent, messages: [user(`从 ${f.work} 到 ${f.other}`)] }).workspace).toBeUndefined();
  expect(buildTurnEnvironment({ agent, messages: [user(`不要放在 ${f.work}`)] }).workspace).toBeUndefined();
});

test('助手默认工作目录保存后重载，各助手互不串用', () => {
  const f = fixture(); const first = f.agents.create({ name: '报销助手', workspaceDirectory: f.work });
  const second = f.agents.create({ name: '周报助手', workspaceDirectory: f.other });
  const again = new WorkbenchAgentStore(new WorkbenchStore(f.store.root));
  expect(again.get(first.id).workspaceDirectory).toBe(realpathSync(f.work));
  expect(again.get(second.id).workspaceDirectory).toBe(realpathSync(f.other));
  expect(() => f.agents.create({ name: '错误目录', workspaceDirectory: join(f.root, 'missing') })).toThrow();
});

test('重新选择相同默认目录可以覆盖对话中的临时位置，清空后不复活旧选择', () => {
  const f = fixture(); let agent = f.agents.create({ name: '报销助手', workspaceDirectory: f.work });
  const older = { ...agent, workspaceUpdatedAt: '2026-10-24T01:00:00Z' };
  expect(buildTurnEnvironment({ agent: older, messages: [user(`这次在 ${f.other}`)] }).workspace?.path).toBe(realpathSync(f.other));
  agent = f.agents.update(agent.id, { revision: agent.revision, workspaceDirectory: f.work, workspaceUpdatedAt: 'selected-again' });
  expect(buildTurnEnvironment({ agent, messages: [user(`这次在 ${f.other}`)] }).workspace?.path).toBe(realpathSync(f.work));
  agent = f.agents.update(agent.id, { revision: agent.revision, workspaceDirectory: '' });
  expect(buildTurnEnvironment({ agent, messages: [user(`这次在 ${f.other}`)] }).workspace).toBeUndefined();
});

test('界面更换工作目录后，历史路径退出当前约束，原对话保留且新建落在当前目录', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手', readDirectories: [f.work, f.other] }); const service = f.open();
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const old = `这次换到 ${f.other}，创建本周报销文件夹，先只做这一步。`;
  const seeded = service.get(conversation.id); seeded.messages.push(user(old, 'old-location'));
  seeded.task = { id: 'task', goal: old, constraints: [old, '清单金额保留两位小数'], sources: [{ messageId: 'old-location', note: old }], updatedAt: '2026-10-25T01:00:00Z' }; seeded.taskNotes = [...seeded.task.constraints]; f.store.save(seeded);
  f.agents.update(agent.id, { revision: agent.revision, workspaceDirectory: f.work });
  let requests = 0;
  __setChatTransportForTests(async options => {
    const system = options.system ?? '';
    expect(system.match(/<current_task>[\s\S]*?<\/current_task>/)?.[0] ?? '').not.toContain(f.other);
    expect(system.match(/<task_brief>[\s\S]*?<\/task_brief>/)?.[0] ?? '').not.toContain(f.other);
    expect(system).toContain('清单金额保留两位小数');
    expect(JSON.stringify(options.messages)).toContain(f.other.replaceAll('\\', '\\\\'));
    return ++requests === 1 ? call('local_mkdir', { name: '复核' }) : answer('已创建文件夹');
  });
  service.send(conversation.id, { text: '在当前工作目录里新建一个叫复核的文件夹' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(existsSync(join(f.work, '复核'))).toBe(true); expect(existsSync(join(f.other, '复核'))).toBe(false);
  expect(service.get(conversation.id).messages.find(message => message.id === 'old-location')?.text).toBe(old);
});

test('缺少目录时允许正常询问，不强迫创建，不写入知识来源目录', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手' }); const service = f.open();
  __setChatTransportForTests(async options => { expect(options.system).toContain('尚未确定'); return answer('这次的报销文件夹建在哪里？'); });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '新建一个本周报销的文件夹' }); await service.settled(conversation.id);
  const reply = service.get(conversation.id).messages.at(-1)!;
  expect(reply.status).toBe('complete'); expect(reply.text).toContain('建在哪里');
  const tools = agentHandlers(f.context, { agent, userText: '新建本周文件夹', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true });
  await expect(tools.get('local_mkdir')!.execute({ name: '本周' }, new AbortController().signal)).rejects.toThrow('目录');
  expect(existsSync(join(f.library, '本周'))).toBe(false);
});

test('压缩前提取用户指定目录，重启和短指令仍沿用；当前纠正优先', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手', readDirectories: [f.work, f.other] }); let service = f.open();
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const seeded = service.get(conversation.id); seeded.messages.push(user(`报销资料位置是 ${f.work}`, 'morning'));
  seeded.summary = '用户希望创建报销目录。'; seeded.summaryUntil = 'morning'; f.store.save(seeded);
  let requests = 0;
  __setChatTransportForTests(async options => { expect(options.system).toContain(f.work); return ++requests === 1 ? call('local_mkdir', { name: '本周报销' }) : answer('已创建文件夹。'); });
  service.send(conversation.id, { text: '新建本周报销的文件夹' }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete'); expect(existsSync(join(f.work, '本周报销'))).toBe(true);
  service = f.open(); requests = 0;
  __setChatTransportForTests(async () => ++requests === 1 ? call('local_mkdir', { name: '新一期' }) : answer('已创建文件夹。'));
  service.send(conversation.id, { text: `改到 ${f.other} ，创建新一期文件夹` }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete'); expect(existsSync(join(f.other, '新一期'))).toBe(true);
  expect(existsSync(join(f.work, '新一期'))).toBe(false);
});

test('创建目录仍召回记忆，简短继续仍带上助手职责和工作步骤', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手', workspaceDirectory: f.work, workflow: '先核对票据，再列缺项，齐全后生成报销清单' });
  const instruction = await agentInstructions(f.context, agent, { userText: '继续', taskActive: true });
  expect(instruction).toContain(agent.workflow);
  let recalled = 0; const service = f.open(async () => { recalled++; return []; });
  __setChatTransportForTests(async options => { expect(options.system).toContain('本周'); return answer('文件夹用什么名称？'); });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '创建文件夹' }); await service.settled(conversation.id);
  expect(recalled).toBe(1); expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
});


test('对话中明确指定目录后可直接执行，授权不偷偷写入其他助手或配置', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '文件助手' }); const service = f.open(); let calls = 0;
  __setChatTransportForTests(async options => { expect(options.tools?.some(tool => tool.name === 'local_read')).toBe(true); return ++calls === 1 ? call('local_mkdir', { name: '验收' }) : answer('已创建文件夹'); });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: `在 ${f.work} 创建一个叫验收的文件夹` }); await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(existsSync(join(f.work, '验收'))).toBe(true);
  expect(f.agents.get(agent.id).readDirectories).toEqual([]);
  expect(f.agents.get(agent.id).workspaceDirectory).toBeUndefined();
});


test('浏览器时区随会话保存并交给每轮运行环境，重启继续不退回服务端时区', async () => {
  const f = fixture(); let zone: string | undefined;
  const service = new WorkbenchService(f.store, () => [{ id: 'local', name: 'local' }], async input => { zone = input.environment?.timeZone; return { text: '收到', model: 'local', citations: [] }; });
  const conversation = service.create({ knowledge: false });
  service.send(conversation.id, { text: '你好', timeZone: 'Asia/Shanghai' }); await service.settled(conversation.id);
  expect(zone).toBe('Asia/Shanghai'); expect(new WorkbenchStore(f.store.root).get(conversation.id).timeZone).toBe('Asia/Shanghai');
  expect(() => service.send(conversation.id, { text: '你好', timeZone: 'invalid' })).toThrow('时区');
});

test('用户指定长期做法时正常确认，知识库已命中也不会强迫这句确认附带引用', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '报销助手' });
  const service = f.open(async () => [{ sourceId: 'default', slug: 'memory/fact-1', title: '已保存偏好', snippet: '使用中文', kind: 'memory', factId: 1 }]);
  __setChatTransportForTests(async () => answer('好的，以后清单先写合计金额，再列明细。'));
  const conversation = service.create({ assistantId: agent.id, knowledge: true });
  service.send(conversation.id, { text: '以后这个项目的清单先写合计金额，再列明细。' }); await service.settled(conversation.id);
  const reply = service.get(conversation.id).messages.at(-1)!;
  expect(reply.status).toBe('complete'); expect(reply.text).toContain('先写合计金额');
  expect(f.agents.get(agent.id).standingRules).toContain('以后这个项目的清单先写合计金额，再列明细。');
});

test('资料问答只开放读取，不能顺手保存文件；明确交付和简短继续保留执行工具', async () => {
  const f = fixture(); const agent = f.agents.create({ name: '周报助手', workspaceDirectory: f.work });
  const question = '这个项目金额是多少？我希望清单先写什么，再写什么？';
  const tools = agentTools(agent, question, f.context);
  expect(tools.some(tool => tool.name === 'local_read')).toBe(true);
  expect(tools.some(tool => ['artifact_save', 'local_mkdir', 'local_copy', 'local_rename'].includes(tool.name))).toBe(false);
  const handlers = agentHandlers(f.context, { agent, userText: question, conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true });
  await expect(handlers.get('artifact_save')!.execute({ title: '不该保存', content: '金额清单' }, new AbortController().signal)).rejects.toThrow();
  for (const text of ['继续', '请保存这份清单', '能帮我生成并保存清单吗？']) expect(agentTools(agent, text, f.context).some(tool => tool.name === 'artifact_save')).toBe(true);
});
