import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInstructions } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { activityLine, skillDraftFromRequest, wantsSavedPlaybook, wantsSavedSkill } from '../src/product/workbench/playbook';
import { nextSkillRuns } from '../src/product/workbench/skill-schedule';
import { PRODUCT_SKILLS, SkillCenter, planTurnSkills, sharedMcpSkills } from '../src/product/workbench/skill-center';
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

test('技能管理可以分享、限定助手和定时，助手设置可以把做法存成技能', () => {
  const page = readSkill('admin/src/product/SkillCenter.tsx');
  expect(page).toContain('允许外部 AI 读取这个技能');
  expect(page).toContain('适用助手');
  expect(page).toContain('定时执行交给所选助手，走原来的任务中心');
  expect(page).toContain('/skill-center/');
  const settings = readSkill('admin/src/workbench/AgentSettings.tsx');
  expect(settings).toContain('存成技能');
  expect(settings).toContain('/skill-center/from-playbook');
  expect(settings).toContain('role="status"');
});
