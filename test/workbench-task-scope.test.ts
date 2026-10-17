import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { learnTurn } from '../src/product/workbench/turn-policy';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-task-scope-')); roots.push(root);
  const store = new WorkbenchStore(root);
  const service = new WorkbenchService(store, () => [{ id: 'mock', name: 'Mock' }], async () => ({ text: '收到', model: 'mock', citations: [] }));
  const agents = new WorkbenchAgentStore(store);
  const agent = agents.create({ name: '材料助手', systemPrompt: '依据资料处理工作', workflow: '先核对资料再交付', skills: ['weekly-report'], standingRules: ['不要编造'] });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const send = async (text: string) => { service.send(conversation.id, { text }); await service.settled(conversation.id); return service.get(conversation.id); };
  return { root, store, service, agents, agent, conversation, send };
}

test('没有明确要求长期生效的改稿纠正只约束当前任务，下一件工作不继承', async () => {
  const f = fixture();
  await f.send('生成本周周报');
  const corrected = await f.send('标题不要日期');
  expect(f.agents.get(f.agent.id).standingRules).toEqual(['不要编造']);
  expect(corrected.task?.decisions).toContain('标题不要日期');
  expect(corrected.messages.at(-1)?.ruleNotice).toContain('当前任务');
  const next = await f.send('生成下周周报');
  expect(next.task?.id).not.toBe(corrected.task?.id);
  expect(next.task?.constraints).toEqual([]);
  expect(next.taskNotes).toBeUndefined();
});

test('一句话里的长期规则和本次要求分别生效', () => {
  const learned = learnTurn({ name: '材料助手', standingRules: [], recentUserTexts: [], text: '以后标题不要日期，这次不要写下周计划' });
  expect(learned.rules).toEqual(['以后标题不要日期']);
  expect(learned.taskNotes).toEqual(['这次不要写下周计划']);
  const reversed = learnTurn({ name: '材料助手', standingRules: [], recentUserTexts: [], text: '这次只写完成事项；以后都用 Word 交付' });
  expect(reversed.rules).toEqual(['以后都用 Word 交付']);
  expect(reversed.taskNotes).toEqual(['这次只写完成事项']);
  const steps = learnTurn({ name: '材料助手', standingRules: [], recentUserTexts: [], text: '以后先写结论；再列事实；这次只写完成事项' });
  expect(steps.rules).toEqual(['以后先写结论', '再列事实']);
  expect(steps.taskNotes).toEqual(['这次只写完成事项']);
});

test('指定原稿段落的修改保留当前任务和成果，不会重新打开另一件任务', async () => {
  const f = fixture();
  const first = await f.send('生成本周周报');
  const stored = f.service.get(f.conversation.id);
  stored.task!.currentArtifactId = 'original-report'; f.store.save(stored);
  const amended = await f.send('只改第二节，其他部分保持原样');
  expect(amended.task?.id).toBe(first.task?.id);
  expect(amended.task?.currentArtifactId).toBe('original-report');
  expect(amended.task?.decisions).toContain('只改第二节，其他部分保持原样');
  expect(amended.messages.at(-1)?.contextManifest?.task?.inherited).toBe(true);
});

test('保存当前做法为长期规则时，不把上一个任务的要求捎进来', async () => {
  const f = fixture();
  await f.send('生成本周周报');
  await f.send('风险不要写那么多');
  await f.send('生成下一期周报');
  await f.send('标题不要日期');
  await f.send('以后都这么做');
  expect(f.agents.get(f.agent.id).standingRules).toEqual(['不要编造', '标题不要日期']);
  const reopened = new WorkbenchAgentStore(new WorkbenchStore(f.root)).get(f.agent.id);
  expect(reopened.standingRules).toEqual(['不要编造', '标题不要日期']);
});

test('普通主助手也能留下工作任务，临时要求可随明确的新任务结束', async () => {
  const f = fixture();
  const conversation = f.service.create({ knowledge: false });
  for (const text of ['帮我整理一份会议纪要', '这次只保留决定事项']) { f.service.send(conversation.id, { text }); await f.service.settled(conversation.id); }
  const first = f.service.get(conversation.id);
  expect(first.task?.goal).toBe('帮我整理一份会议纪要');
  expect(first.task?.constraints).toContain('这次只保留决定事项');
  f.service.send(conversation.id, { text: '另做一份项目方案' }); await f.service.settled(conversation.id);
  const next = f.service.get(conversation.id);
  expect(next.task?.id).not.toBe(first.task?.id);
  expect(next.task?.constraints).toEqual([]);
});

test('询问规则和引用他人要求时不会改写助手的长期规则', () => {
  for (const text of ['为什么标题要改成这样？', '文档原文是“以后都不要写日期”，帮我解释这句话']) {
    const learned = learnTurn({ name: '材料助手', standingRules: ['不要编造'], recentUserTexts: [], text });
    expect(learned.rules).toEqual(['不要编造']);
    expect(learned.added).toEqual([]);
  }
});
