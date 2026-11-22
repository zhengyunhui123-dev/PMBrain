import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTools } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-collab-'));
const models = () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }];

function world(answer: (input: { messages: Array<{ text: string }> }) => Promise<{ text: string; model: string; citations: []; stopReason?: 'end' | 'length' }>) {
  const store = new WorkbenchStore(root());
  const agents = new WorkbenchAgentStore(store);
  const specialist = agents.create({ name: '周报助手', systemPrompt: '按资料写周报', workflow: '先看资料再写' });
  const service = new WorkbenchService(store, models, answer);
  return { store, agents, specialist, service };
}

test('请另一个助手做事，会把对方的真实回复交回这次对话', async () => {
  const seen: string[] = [];
  const { service, specialist, agents } = world(async input => {
    seen.push(input.messages.at(-1)?.text ?? '');
    return { text: '周报已经按资料写好', model: 'ollama:local', citations: [] };
  });
  const result = await service.collaborate({ assistantId: specialist.id, prompt: '写本周周报', from: { assistantId: 'main', conversationId: 'caller' } }) as { text: string; collaborated: boolean; assistantName: string; conversationId: string };
  expect(result.collaborated).toBe(true);
  expect(result.assistantName).toBe('周报助手');
  expect(result.text).toBe('周报已经按资料写好');
  expect(seen[0]).toContain('请只完成本次协作');
  expect(seen[0]).toContain('写本周周报');
  const conversation = service.get(result.conversationId);
  expect(conversation.messages[0]?.collaborationFrom).toEqual({ assistantId: 'main', conversationId: 'caller' });
  expect(agents.get(specialist.id).standingRules ?? []).toEqual([]);
  expect(agents.get(specialist.id).playbook ?? null).toBeNull();
});

test('协作里说记住或存成做法，也不会改对方的长期规则', async () => {
  const { service, specialist, agents } = world(async () => ({ text: '好', model: 'ollama:local', citations: [] }));
  await service.collaborate({ assistantId: specialist.id, prompt: '记住，以后都这么做，并把这次存成做法', from: { assistantId: 'main', conversationId: 'caller' } });
  const saved = agents.get(specialist.id);
  expect(saved.standingRules ?? []).toEqual([]);
  expect(saved.playbook ?? null).toBeNull();
});

test('不能交给自己，对方正在回答时要拒绝，取消前也不会先写进对话', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { service, specialist } = world(async () => { await gate; return { text: '好', model: 'ollama:local', citations: [] }; });
  await expect(service.collaborate({ assistantId: 'main', prompt: '写一段', from: { assistantId: 'main', conversationId: 'caller' } })).rejects.toThrow('不能把工作交给自己');
  const target = service.create({ assistantId: specialist.id, knowledge: false });
  service.send(target.id, { text: '先回答', knowledge: false });
  await service.accepted(target.id);
  await expect(service.collaborate({ assistantId: specialist.id, prompt: '再写一段', from: { assistantId: 'main', conversationId: 'caller' } })).rejects.toThrow('这个助手正在回答');
  expect(service.get(target.id).messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['先回答']);
  release();
  await service.settled(target.id);
  const stopped = new AbortController();
  stopped.abort();
  const fresh = world(async () => ({ text: '不该出现', model: 'ollama:local', citations: [] }));
  await expect(fresh.service.collaborate({ assistantId: fresh.specialist.id, prompt: '写一段', from: { assistantId: 'main', conversationId: 'caller' }, signal: stopped.signal })).rejects.toThrow('已停止生成');
  expect(fresh.service.openAssistant(fresh.specialist.id)).toBeNull();
});

test('对方失败就是失败，写到长度上限时要说明还没写完', async () => {
  const failed = world(async () => { throw new Error('模型失败'); });
  await expect(failed.service.collaborate({ assistantId: failed.specialist.id, prompt: '写一段', from: { assistantId: 'main', conversationId: 'caller' } })).rejects.toThrow('模型失败');
  const long = world(async () => ({ text: '字'.repeat(9000), model: 'ollama:local', citations: [], stopReason: 'length' }));
  const result = await long.service.collaborate({ assistantId: long.specialist.id, prompt: '写很长的一段', from: { assistantId: 'main', conversationId: 'caller' } }) as { text: string; truncated: boolean; incomplete?: boolean; note?: string };
  expect(result.text).toHaveLength(8000);
  expect(result.truncated).toBe(true);
  expect(result.incomplete).toBe(true);
  expect(result.note).toContain('尚未写完');
});

test('纯提问不露出协作工具，交代工作或点名助手时才露出，转进来的协作不能再转出去', () => {
  const store = new WorkbenchStore(root());
  const agents = new WorkbenchAgentStore(store);
  const agent = agents.create({ name: '文件助手', workflow: '按要求做' });
  const context = { store: agents, engine: { executeRaw: async () => [] }, config: () => ({ engine: 'pglite' as const }), collaborate: async () => ({ collaborated: true }) } as any;
  const names = (text: string, inbound = false) => agentTools(agent, text, context, undefined, { collaborationInbound: inbound }).map(tool => tool.name);
  expect(names('这是什么？')).not.toContain('assistant_collaborate');
  expect(names('请整理本周进展')).toContain('assistant_collaborate');
  expect(names('让周报助手看一下这是什么？')).toContain('assistant_collaborate');
  expect(names('确认创建周报助手', true)).not.toContain('assistant_collaborate');
  expect(names('确认创建周报助手', true)).not.toContain('assistant_create');
});
