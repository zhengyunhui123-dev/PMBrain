import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInstructions, judgeSkillWithModel } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { activityLine, skillDraftFromRequest, wantsSavedPlaybook, wantsSavedSkill } from '../src/product/workbench/playbook';
import { nextSkillRuns } from '../src/product/workbench/skill-schedule';
import { concludeSkillRun, PRODUCT_SKILLS, SkillCenter, planTurnSkills, refineTurnSkills, sharedMcpSkills } from '../src/product/workbench/skill-center';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { operationsByName, type OperationContext } from '../src/core/operations';
import { readSharedSkillsSafe, setSharedSkillReader } from '../src/core/skill-catalog';

afterEach(() => setSharedSkillReader(undefined));

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-skill-phase3-'));
const center = () => {
  const dir = root();
  return { dir, skills: new SkillCenter(dir, async () => PRODUCT_SKILLS.map(skill => ({ ...skill }))) };
};
const serviceFor = (store: WorkbenchStore) => new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '好', model: 'ollama:local', citations: [] }));
const replyOf = (store: WorkbenchStore, id: string) => store.get(id).messages.at(-1);
const localContext = (): OperationContext => ({ engine: { getConfig: async () => null }, config: {}, logger: console, dryRun: false, remote: false }) as unknown as OperationContext;
const readSkill = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('保存为技能会写成用户技能，就按这次的存下来仍然只存做法', () => {
  expect(wantsSavedPlaybook('保存为技能')).toBe(false);
  expect(wantsSavedPlaybook('就按这次的存下来')).toBe(true);
  expect(wantsSavedSkill('保存为技能')).toBe(true);
  expect(wantsSavedSkill('把这次的方法保存为技能')).toBe(true);
  expect(wantsSavedSkill('就按这次的存下来')).toBe(false);
  expect(skillDraftFromRequest('帮我创建一个产品需求分析技能')?.displayName).toBe('产品需求分析');
  expect(skillDraftFromRequest('建一个产品需求分析技能')?.displayName).toBe('产品需求分析');
  expect(skillDraftFromRequest('帮我创建一个技能')).toBeUndefined();
});

test('说把这次的方法保存为技能后，另一个助手下一句就能用，同名不再复制', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = serviceFor(store);
  const agent = new WorkbenchAgentStore(store).create({ name: '项目复盘', workflow: '先核对来源，再写结论', skills: [], systemPrompt: '你负责项目复盘' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '先核对来源，再写结论，不要编造' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '把这次的方法保存为技能' });
  await service.settled(conversation.id);
  const saved = replyOf(store, conversation.id);
  expect(saved?.skillNotice).toContain('已把这次的做法存成技能');
  expect(saved?.savedSkill).toBe('项目复盘');
  expect(activityLine(store.get(conversation.id).messages, false)).toBe('已存成技能');
  expect(new WorkbenchAgentStore(store).get(agent.id).playbook).toBeFalsy();
  const files = readdirSync(join(dir, 'user-skills'));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(dir, 'user-skills', files[0]!, 'SKILL.md'), 'utf8')).toContain('不要编造');
  const other = new WorkbenchAgentStore(store).create({ name: '另一助手', workflow: '协助整理', skills: [], systemPrompt: '你协助整理' });
  const instructions = await agentInstructions({ store: new WorkbenchAgentStore(store), engine: { getConfig: async () => null }, config: () => ({}) } as never, other, { userText: '请做项目复盘' });
  expect(instructions).toContain('不要编造');
  expect(instructions).not.toContain('<skill name="weekly-report">');
  service.send(conversation.id, { text: '再把这次的方法保存为技能' });
  await service.settled(conversation.id);
  expect(replyOf(store, conversation.id)?.skillNotice).toContain('已有同名技能');
  expect(readdirSync(join(dir, 'user-skills'))).toHaveLength(1);
});

test('创建技能要等这句对话确认，确认后其他助手不用重启就能用', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = serviceFor(store);
  const agent = new WorkbenchAgentStore(store).create({ name: '需求助手', workflow: '整理需求', skills: [], systemPrompt: '你整理需求' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '帮我创建一个技能' });
  await service.settled(conversation.id);
  expect(replyOf(store, conversation.id)?.skillNotice).toContain('请说清技能名称');
  expect(existsSync(join(dir, 'user-skills'))).toBe(false);
  service.send(conversation.id, { text: '帮我创建一个产品需求分析技能' });
  await service.settled(conversation.id);
  expect(replyOf(store, conversation.id)?.skillNotice).toContain('确认创建这个技能');
  expect(replyOf(store, conversation.id)?.savedSkill).toBeUndefined();
  expect(existsSync(join(dir, 'user-skills'))).toBe(false);
  const otherConversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(otherConversation.id, { text: '确认创建这个技能' });
  await service.settled(otherConversation.id);
  expect(replyOf(store, otherConversation.id)?.skillNotice).toContain('这个对话里没有待确认的技能');
  expect(existsSync(join(dir, 'user-skills'))).toBe(false);
  service.send(conversation.id, { text: '确认创建这个技能' });
  await service.settled(conversation.id);
  expect(replyOf(store, conversation.id)?.savedSkill).toBe('产品需求分析');
  expect(readdirSync(join(dir, 'user-skills'))).toHaveLength(1);
  const second = new WorkbenchAgentStore(store).create({ name: '另一助手', workflow: '协助整理', skills: [], systemPrompt: '你协助整理' });
  const instructions = await agentInstructions({ store: new WorkbenchAgentStore(store), engine: { getConfig: async () => null }, config: () => ({}) } as never, second, { userText: '请做产品需求分析' });
  expect(instructions).toContain('先检索已授权资料');
});

test('限定助手后，其他助手只有说出技能名称才会自动用', async () => {
  const { skills } = center();
  const created = await skills.create({ displayName: '需求拆解', description: '把需求拆成可核对的条目', triggers: ['写需求'], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], steps: '先列出需求，再核对来源，最后保存。' });
  const open = planTurnSkills({ text: '帮我写需求', pinned: [], follow: false, cards: await skills.list(), agentId: 'beta' });
  expect(open.loaded.map(card => card.name)).toContain(created.name);
  await skills.setAudience(created.name, ['alpha']);
  const blocked = planTurnSkills({ text: '帮我写需求', pinned: [], follow: false, cards: await skills.list(), agentId: 'beta' });
  expect(blocked.loaded.map(card => card.name)).not.toContain(created.name);
  const named = planTurnSkills({ text: '请使用需求拆解', pinned: [], follow: false, cards: await skills.list(), agentId: 'beta' });
  expect(named.loaded.map(card => card.name)).toContain(created.name);
  const owner = planTurnSkills({ text: '帮我写需求', pinned: [], follow: false, cards: await skills.list(), agentId: 'alpha' });
  expect(owner.loaded.map(card => card.name)).toContain(created.name);
});

test('旧的技能状态文件没有分享和定时字段时仍能读取', async () => {
  const { dir, skills } = center();
  writeFileSync(join(dir, 'skill-center.json'), JSON.stringify({ disabled: ['weekly-report'] }));
  const listed = await skills.list();
  const weekly = listed.find(item => item.name === 'weekly-report');
  expect(weekly?.enabled).toBe(false);
  expect(weekly?.shared).toBe(false);
  expect(weekly?.assistants).toEqual([]);
  expect(weekly?.schedule).toBeUndefined();
});

test('只有单独打开分享的只读自定义技能才会进入外部技能目录', async () => {
  const { dir, skills } = center();
  const created = await skills.create({ displayName: '需求核对', description: '核对需求并保存结果', triggers: ['需求核对'], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], steps: '先检索资料，再列出缺口，并保存结果。' });
  const shell = await skills.create({ displayName: '外部命令技能', description: '运行外部命令', triggers: ['运行外部命令'], tools: ['shell'], steps: '调用外部命令并回报结果。' });
  expect(await sharedMcpSkills(dir)).toEqual([]);
  await expect(skills.setShared(shell.name, true)).rejects.toThrow(/分享/);
  await expect(skills.setShared('weekly-report', true)).rejects.toThrow(/自己创建/);
  await expect(skills.setSchedule(shell.name, { enabled: true, weekdays: [1], time: '09:00', timezone: 'UTC', prompt: '运行', assistantId: 'main' })).rejects.toThrow(/定时/);
  setSharedSkillReader(() => sharedMcpSkills(dir));
  const hidden = await operationsByName.list_skills.handler(localContext(), {}) as { skills: Array<{ name: string }> };
  expect(hidden.skills.some(item => item.name.startsWith('user__'))).toBe(false);
  await expect(operationsByName.get_skill.handler(localContext(), { name: created.name })).rejects.toThrow(/not found/i);
  await skills.setShared(created.name, true);
  const shared = await readSharedSkillsSafe();
  expect(shared.map(item => item.name)).toEqual([created.name]);
  const listed = await operationsByName.list_skills.handler(localContext(), {}) as { skills: Array<{ name: string }> };
  expect(listed.skills.some(item => item.name === created.name)).toBe(true);
  const detail = await operationsByName.get_skill.handler(localContext(), { name: created.name }) as { body: string; client_guidance?: { protocol: string[] } };
  expect(detail.body).toContain('先检索资料');
  expect(detail.client_guidance?.protocol.some(line => line.includes('does not grant new tools'))).toBe(true);
  await expect(operationsByName.list_skills.handler({ ...localContext(), remote: true }, {})).rejects.toThrow(/disabled/i);
});

test('到点的技能只提交一次，失败标记后同一时刻不再重复', async () => {
  const { skills } = center();
  const created = await skills.create({ displayName: '定时复盘', description: '到点后做项目复盘', triggers: ['定时复盘'], tools: ['knowledge_search', 'artifact_save'], steps: '先检索本期资料，再保存复盘。' });
  await skills.setSchedule(created.name, { enabled: true, weekdays: [0, 1, 2, 3, 4, 5, 6], time: '09:00', timezone: 'UTC', prompt: '写复盘', assistantId: 'main' });
  const now = new Date('2026-10-25T10:00:00.000Z');
  const due = nextSkillRuns(await skills.list(), skills.scheduleMarks(), now).filter(run => run.name === created.name);
  expect(due).toHaveLength(1);
  expect(due[0]?.assistantId).toBe('main');
  expect(due[0]?.prompt).toContain('请使用技能「定时复盘」');
  expect(due[0]?.prompt).toContain('写复盘');
  const blocked = nextSkillRuns([{ ...(await skills.list()).find(card => card.name === created.name)!, supported: false }], {}, now);
  expect(blocked).toHaveLength(0);
  skills.markSchedule(created.name, due[0]!.slot, 'failed');
  expect(nextSkillRuns(await skills.list(), skills.scheduleMarks(), now).some(run => run.name === created.name)).toBe(false);
});

const skillFile = (frontmatter: string, title: string) => `---\n${frontmatter.trim()}\n---\n\n# ${title}\n\n按声明完成，不要改权限。\n`;

test('停用后外部 AI 读不到已分享技能，重新启用后恢复', async () => {
  const { dir, skills } = center();
  const created = await skills.create({ displayName: '需求核对', description: '核对需求并保存结果', triggers: ['需求核对'], tools: ['knowledge_search', 'knowledge_read', 'artifact_save'], steps: '先检索资料，再列出缺口，并保存结果。' });
  await skills.setShared(created.name, true);
  setSharedSkillReader(() => sharedMcpSkills(dir));
  expect((await sharedMcpSkills(dir)).map(item => item.name)).toEqual([created.name]);
  await skills.setEnabled(created.name, false);
  expect((await skills.list()).find(item => item.name === created.name)?.shared).toBe(true);
  expect(await sharedMcpSkills(dir)).toEqual([]);
  const hidden = await operationsByName.list_skills.handler(localContext(), {}) as { skills: Array<{ name: string }> };
  expect(hidden.skills.some(item => item.name === created.name)).toBe(false);
  await expect(operationsByName.get_skill.handler(localContext(), { name: created.name })).rejects.toThrow(/not found/i);
  await skills.setEnabled(created.name, true);
  expect((await sharedMcpSkills(dir)).map(item => item.name)).toEqual([created.name]);
  const visible = await operationsByName.list_skills.handler(localContext(), {}) as { skills: Array<{ name: string }> };
  expect(visible.skills.some(item => item.name === created.name)).toBe(true);
});

test('导入技能保留写入声明，不把写入型技能改成只读', async () => {
  const { dir, skills } = center();
  const quiet = await skills.importMarkdown(skillFile(`
name: quiet-write
description: "看起来只读"
triggers:
  - "静默写入"
tools:
  - knowledge_search
mutating: true
writes_pages: true
`, '静默写入'));
  const quietFile = readFileSync(join(dir, 'user-skills', quiet.name.replace(/^user__/, ''), 'SKILL.md'), 'utf8');
  expect(quietFile).toContain('mutating: true');
  expect(quietFile).toContain('writes_pages: true');
  expect(quiet.tools).toEqual(['knowledge_search']);
  expect(quiet.supported).toBe(false);
  expect(quiet.permission).toBe('write');
  await expect(skills.setEnabled(quiet.name, true)).rejects.toThrow(/不能自动调用/);
  await skills.update(quiet.name, { displayName: quiet.displayName, description: quiet.description, triggers: quiet.triggers, tools: quiet.tools, steps: '更新步骤后仍然会改知识库。' });
  expect(readFileSync(join(dir, 'user-skills', quiet.name.replace(/^user__/, ''), 'SKILL.md'), 'utf8')).toContain('writes_pages: true');
  const flagged = await skills.importMarkdown(skillFile(`
name: flag-only
description: "只有写入标记"
triggers:
  - "只写标记"
mutating: true
writes_pages: true
`, '只写标记'));
  const flaggedFile = readFileSync(join(dir, 'user-skills', flagged.name.replace(/^user__/, ''), 'SKILL.md'), 'utf8');
  expect(flaggedFile).toContain('mutating: true');
  expect(flaggedFile).not.toContain('knowledge_search');
  expect(flagged.supported).toBe(false);
  const reading = await skills.importMarkdown(skillFile(`
name: read-notes
description: "只读整理"
triggers:
  - "只读整理"
tools:
  - knowledge_search
mutating: false
writes_pages: false
`, '只读整理'));
  expect(reading.supported).toBe(true);
  expect(reading.permission).toBe('read');
});

test('明确提到周报时不询问模型，含糊的会议任务只在低置信度时问一次', async () => {
  const bare = { id: 'main', name: '主助手', skills: [], workflow: '', sourceIds: ['default'], standingRules: [], readDirectories: [] } as never;
  let calls = 0;
  const judge = async (input: { catalog: string }) => { calls += 1; expect(input.catalog).toContain('Synthesized trigger index'); expect(input.catalog).toContain('meeting-notes'); return 'meeting-notes'; };
  const weekly = await agentInstructions({ engine: {}, config: () => ({}) } as never, bare, { userText: '帮我写周报', judge });
  expect(weekly).toContain('<skill name="weekly-report">');
  expect(calls).toBe(0);
  const meeting = await agentInstructions({ engine: {}, config: () => ({}) } as never, bare, { userText: '把今天讨论的事情整理一下，列出谁负责、什么时候完成', judge });
  expect(calls).toBe(1);
  expect(meeting).toContain('<skill name="meeting-notes">');
  expect(meeting).not.toContain('<skill name="weekly-report">');
  calls = 0;
  const failed = await agentInstructions({ engine: {}, config: () => ({}) } as never, bare, { userText: '把今天讨论的事情整理一下，列出谁负责、什么时候完成', judge: async () => { calls += 1; throw new Error('模型不可用'); } });
  expect(calls).toBe(1);
  expect(failed).not.toContain('<skill name="meeting-notes">');
  calls = 0;
  await agentInstructions({ engine: {}, config: () => ({}) } as never, bare, { userText: '你好', judge: async () => { calls += 1; return 'weekly-report'; } });
  expect(calls).toBe(0);
  const disabled = planTurnSkills({ text: '整理会议', pinned: [], follow: false, cards: PRODUCT_SKILLS.map(skill => skill.name === 'meeting-notes' ? { ...skill, enabled: false } : { ...skill }) });
  const kept = await refineTurnSkills(disabled, { text: '整理会议', pinned: [], follow: false, cards: PRODUCT_SKILLS.map(skill => skill.name === 'meeting-notes' ? { ...skill, enabled: false } : { ...skill }) }, async () => { calls += 1; return 'weekly-report'; });
  expect(calls).toBe(0);
  expect(kept.notice).toContain('已停用');
  expect(await judgeSkillWithModel(async () => { calls += 1; return { text: 'weekly-report' }; }, 'service-agent:chat', new AbortController().signal, { text: '整理一下', catalog: 'x' })).toBeUndefined();
  expect(calls).toBe(0);
});

test('技能先记已加载，工具真正完成后才记成功，另一个助手可以复用', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const agent = new WorkbenchAgentStore(store).create({ name: '需求助手', workflow: '整理需求', skills: [], systemPrompt: '你整理需求' });
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async input => {
    input.onTool?.({ id: 'tool-1', name: 'artifact_save', input: '{}', status: 'complete', startedAt: new Date().toISOString(), output: '{"path":"notes.md"}' });
    return { text: '已保存', model: 'ollama:local', citations: [] };
  });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '帮我创建一个产品需求分析技能' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '确认创建这个技能' });
  await service.settled(conversation.id);
  const skills = new SkillCenter(dir, () => PRODUCT_SKILLS.map(skill => ({ ...skill })));
  const created = (await skills.list()).find(card => card.displayName === '产品需求分析');
  expect(created?.name.startsWith('user__')).toBe(true);
  const second = new WorkbenchAgentStore(store).create({ name: '另一助手', workflow: '协助整理', skills: [], systemPrompt: '你协助整理' });
  const instructions = await agentInstructions({ store: new WorkbenchAgentStore(store), engine: { getConfig: async () => null }, config: () => ({}) } as never, second, { userText: '请做产品需求分析' });
  expect(instructions).toContain('先检索已授权资料');
  const loaded = (await skills.detail(created!.name)).runs[0];
  expect(loaded?.status).toBe('loaded');
  const done = skills.settle(loaded!.id!, concludeSkillRun({ status: 'complete', toolCalls: [{ name: 'artifact_save', status: 'complete' }] }));
  expect(done?.status).toBe('success');
  expect(done?.tools).toEqual(['artifact_save']);
  expect(done?.result).toBe('已完成');
  expect(concludeSkillRun({ status: 'error', error: '模型没有返回', toolCalls: [] }).status).toBe('failed');
  expect(concludeSkillRun({ status: 'cancelled', toolCalls: [{ name: 'artifact_save', status: 'cancelled' }] }).status).toBe('cancelled');
  const replay = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async input => {
    input.onSkillRun?.(loaded!.id!);
    input.onTool?.({ id: 'tool-2', name: 'knowledge_search', input: '{}', status: 'complete', startedAt: new Date().toISOString(), output: '{}' });
    return { text: '分析已写完', model: 'ollama:local', citations: [] };
  });
  const again = replay.create({ assistantId: second.id, knowledge: false });
  replay.send(again.id, { text: '请做产品需求分析' });
  await replay.settled(again.id);
  const finished = (await skills.detail(created!.name)).runs[0];
  expect(finished?.status).toBe('success');
  expect(finished?.tools).toContain('knowledge_search');
});

test('技能管理可以分享、限定助手和定时，助手设置可以把做法存成技能', () => {
  const page = readSkill('admin/src/product/SkillCenter.tsx');
  expect(page).toContain("loaded: '已加载'");
  expect(page).not.toContain('已调用');
  expect(page).toContain('还没有执行记录');
  expect(page).toContain('允许外部 AI 读取这个技能');
  expect(page).toContain('适用助手');
  expect(page).toContain('定时执行交给所选助手，走原来的任务中心');
  expect(page).toContain('/skill-center/');
  const settings = readSkill('admin/src/workbench/AgentSettings.tsx');
  expect(settings).toContain('存成技能');
  expect(settings).toContain('/skill-center/from-playbook');
  expect(settings).toContain('role="status"');
});
