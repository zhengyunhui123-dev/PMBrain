import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { agentInstructions } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { registerWorkbenchRoutes } from '../src/product/workbench/routes';
import { setSharedSkillReader } from '../src/core/skill-catalog';
import { SkillCenter, planTurnSkills, PRODUCT_SKILLS, type SkillCard } from '../src/product/workbench/skill-center';
import { WorkbenchStore } from '../src/product/workbench/store';
import { defaultAssistant } from '../shared/workbench';

const agent = { ...defaultAssistant(), id: 'weekly', revision: 1, name: '周报助手', skills: ['weekly-report', 'library__meeting'], workflow: '先查知识库，再写完成事项、问题和计划', sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' as const, createdAt: '', updatedAt: '' };

function center(cards: SkillCard[] = PRODUCT_SKILLS) {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-skill-center-'));
  return { root, skills: new SkillCenter(root, async () => cards.map(card => ({ ...card }))) };
}

test('说写周报时只带上周报技能，不把另一个已绑定技能一起塞进上下文', async () => {
  const instructions = await agentInstructions({ engine: {}, config: () => ({}) } as never, agent, { userText: '帮我写一份本周项目周报' });
  expect(instructions).toContain('<skill name="weekly-report">');
  expect(instructions).toContain('计划不能写成已完成');
  expect(instructions).not.toContain('library__meeting');
  expect(instructions).not.toContain('<skill name="knowledge-search">');
});

test('没有预先绑定技能时，一句写周报也能匹配周报写作', async () => {
  const instructions = await agentInstructions({ engine: {}, config: () => ({}) } as never, { ...agent, skills: [] }, { userText: '帮我写一份本周项目周报' });
  expect(instructions).toContain('<skill name="weekly-report">');
});

test('停用周报后，同样的话不再自动调用', async () => {
  const { skills } = center();
  await skills.setEnabled('weekly-report', false);
  const listed = await skills.list();
  expect(listed.find(item => item.name === 'weekly-report')?.enabled).toBe(false);
  const plan = planTurnSkills({ text: '帮我写一份本周项目周报', pinned: ['weekly-report'], follow: false, cards: listed });
  expect(plan.loaded).toHaveLength(0);
  expect(plan.notice).toContain('已停用');
});

test('新建的技能不用重启，下一句就能按触发条件调用', async () => {
  const { root, skills } = center();
  const created = await skills.create({ displayName: '产品需求分析', description: '按指定规则分析需求并形成文档', triggers: ['产品需求分析'], tools: ['knowledge_search', 'artifact_save'], steps: '先列出需求，再核对来源，最后保存文档。' });
  expect(created.name.startsWith('user__')).toBe(true);
  const store = new WorkbenchStore(root);
  const instructions = await agentInstructions({ store: new WorkbenchAgentStore(store), engine: { getConfig: async () => null }, config: () => ({}) } as never, { ...agent, skills: [] }, { userText: '帮我做产品需求分析' });
  expect(instructions).toContain('先列出需求，再核对来源，最后保存文档。');
  expect(instructions).not.toContain('<skill name="weekly-report">');
});

test('缺少工具时说明原因，不执行这个技能', () => {
  const broken: SkillCard = { ...PRODUCT_SKILLS[0]!, name: 'shell-job', displayName: '外部命令', description: '运行命令', triggers: ['运行命令'], tools: ['shell'], supported: false, missingTools: ['shell'], permission: 'external', kind: 'custom', origin: 'custom' };
  const plan = planTurnSkills({ text: '帮我运行命令', pinned: [], follow: false, cards: [broken] });
  expect(plan.loaded).toHaveLength(0);
  expect(plan.notice).toContain('缺少工具：shell');
});

test('两个技能同样贴切时先请用户选择，不加载任何一份正文', () => {
  const left: SkillCard = { ...PRODUCT_SKILLS[2]!, name: 'report-a', displayName: '项目周报', triggers: ['写周报'], kind: 'custom', origin: 'custom' };
  const right: SkillCard = { ...PRODUCT_SKILLS[2]!, name: 'report-b', displayName: '部门周报', triggers: ['写周报'], kind: 'custom', origin: 'custom' };
  const plan = planTurnSkills({ text: '帮我写周报', pinned: [], follow: false, cards: [left, right] });
  expect(plan.loaded).toHaveLength(0);
  expect(plan.notice).toContain('请说明要用哪一个');
});

test('复制内置技能只生成我的技能，不改原件', async () => {
  const original = PRODUCT_SKILLS.find(skill => skill.name === 'weekly-report')!.body;
  const { root, skills } = center();
  const copy = await skills.copy('weekly-report');
  expect(copy.origin).toBe('custom');
  expect(copy.name).not.toBe('weekly-report');
  expect(PRODUCT_SKILLS.find(skill => skill.name === 'weekly-report')!.body).toBe(original);
  expect(readFileSync(join(root, 'user-skills', copy.name.replace(/^user__/, ''), 'SKILL.md'), 'utf8')).toContain('计划不能写成已完成');
});

test('深度整理只提示需要确认，不把整理步骤放进上下文', async () => {
  const instructions = await agentInstructions({ engine: {}, config: () => ({}) } as never, { ...agent, skills: [] }, { userText: '请开始整理知识' });
  expect(instructions).toContain('不会自动执行');
  expect(instructions).not.toContain('<skill name="knowledge-organize">');
});

test('技能管理接口可以创建、停用和删除，不依赖重启', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-skill-http-'));
  const app = express();
  registerWorkbenchRoutes(app, (_req, _res, next) => next(), { getConfig: async () => null, executeRaw: async () => [] } as never, { engine: 'pglite' } as never, { storageRoot: root, answer: async () => ({ text: '好', model: 'test', citations: [] }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/admin/api/workbench`;
  try {
    const listed = await fetch(`${base}/skill-center`);
    const catalog = await listed.json() as { skills: Array<{ name: string }> };
    expect(catalog.skills.some(skill => skill.name === 'weekly-report')).toBe(true);
    const created = await fetch(`${base}/skill-center`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '行业信息整理', description: '整理资料并提取行业观点', triggers: ['行业信息整理'], tools: ['knowledge_search'], steps: '先检索，再列出观点和来源。' }) });
    expect(created.status).toBe(200);
    const skill = (await created.json() as { skill: { name: string } }).skill;
    const shared = await fetch(`${base}/skill-center/${encodeURIComponent(skill.name)}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shared: true }) });
    expect((await shared.json() as { skill: { shared: boolean } }).skill.shared).toBe(true);
    const audience = await fetch(`${base}/skill-center/${encodeURIComponent(skill.name)}/audience`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistants: ['main'] }) });
    expect((await audience.json() as { skill: { assistants: string[] } }).skill.assistants).toEqual(['main']);
    const schedule = await fetch(`${base}/skill-center/${encodeURIComponent(skill.name)}/schedule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: { enabled: true, weekdays: [1], time: '09:00', timezone: 'UTC', prompt: '整理行业信息', assistantId: 'main' } }) });
    expect((await schedule.json() as { skill: { schedule?: { enabled: boolean } } }).skill.schedule?.enabled).toBe(true);
    const missingPlaybook = await fetch(`${base}/skill-center/from-playbook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'main' }) });
    expect(missingPlaybook.status).toBe(400);
    expect(await missingPlaybook.json()).toEqual({ error: '还没有可转换的做法' });
    const disabled = await fetch(`${base}/skill-center/${encodeURIComponent(skill.name)}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect((await disabled.json() as { skill: { enabled: boolean } }).skill.enabled).toBe(false);
    const removed = await fetch(`${base}/skill-center/${encodeURIComponent(skill.name)}`, { method: 'DELETE' });
    expect((await removed.json() as { removed: boolean }).removed).toBe(true);
  } finally {
    setSharedSkillReader(undefined);
    server.close();
  }
});

test('技能管理放在设置里，回答里能看到用了哪个技能', () => {
  const page = readFileSync(new URL('../admin/src/product/ProductApp.tsx', import.meta.url), 'utf8');
  const nav = page.slice(page.indexOf('const primaryNav'), page.indexOf('] as const;'));
  expect(page).toContain("key: 'skills', label: '技能管理'");
  expect(nav).not.toContain('技能管理');
  expect(readFileSync(new URL('../admin/src/workbench/Message.tsx', import.meta.url), 'utf8')).toContain('使用技能：');
});
