import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexResolverTriggers, lintRoutingFixtures, runRoutingEval } from '../src/core/routing-eval';
import { entriesToResolverContent, FRONTMATTER_SECTION } from '../src/core/skill-trigger-index';
import { agentInstructions, draftSkillWithModel } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { skillDraftFromRequest } from '../src/product/workbench/playbook';
import { applyModelSkillDraft, authorizedWriteTools, PRODUCT_SKILLS, planTurnSkills, SkillCenter, skillDraftFromModel } from '../src/product/workbench/skill-center';
import { workbenchMemoryTools } from '../src/product/workbench/memory-tools';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-skill-loop-'));
const resolver = entriesToResolverContent([
  { trigger: '写周报', skillPath: 'skills/weekly-report/SKILL.md', isGStack: false, section: FRONTMATTER_SECTION, source: 'frontmatter' },
  { trigger: '整理会议', skillPath: 'skills/meeting-notes/SKILL.md', isGStack: false, section: FRONTMATTER_SECTION, source: 'frontmatter' },
]);

test('技能路由沿用结构化评测，能分出命中、没命中和冲突', () => {
  const fixtures = [
    { intent: '请帮我写周报', expected_skill: 'weekly-report' },
    { intent: '今天天气怎么样', expected_skill: null },
    { intent: '请写周报，还要整理会议', expected_skill: 'weekly-report' },
  ];
  const report = runRoutingEval(resolver, fixtures);
  const marked = runRoutingEval(resolver, fixtures, { llm: true });
  expect(report.passed).toBe(2);
  expect(report.falsePositives).toBe(0);
  expect(report.ambiguous).toBe(1);
  expect(report.details[1]?.outcome).toBe('pass');
  expect(marked.passed).toBe(report.passed);
  expect(marked.ambiguous).toBe(report.ambiguous);
  const index = indexResolverTriggers(resolver);
  expect(lintRoutingFixtures([{ intent: '写周报', expected_skill: 'weekly-report' }], index).map(issue => issue.reason)).toContain('intent_copies_trigger');
});

test('一句话里的两个步骤会按顺序加载两份只读技能', async () => {
  const plan = planTurnSkills({ text: '先检索资料，然后整理会议纪要', pinned: [], follow: false, cards: PRODUCT_SKILLS });
  expect(plan.loaded.map(card => card.name)).toEqual(['knowledge-search', 'meeting-notes']);
  expect(plan.notice).toContain('按顺序');
  const instructions = await agentInstructions({ engine: {}, config: () => ({}) } as never, { id: 'main', name: '主助手', skills: [], sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' } as never, { userText: '先检索资料，然后整理会议纪要' });
  expect(instructions).toContain('按顺序使用这些技能');
  expect(instructions).toContain('引用编号');
  expect(instructions).toContain('行动项');
  expect(instructions).not.toContain('计划不能写成已完成');
});

test('两个技能同样贴切时仍然不加载，确认后才执行写入技能', async () => {
  const left = { ...PRODUCT_SKILLS[2]!, name: 'report-a', displayName: '项目周报', triggers: ['写周报'], kind: 'custom' as const, origin: 'custom' as const };
  const right = { ...PRODUCT_SKILLS[2]!, name: 'report-b', displayName: '部门周报', triggers: ['写周报'], kind: 'custom' as const, origin: 'custom' as const };
  const tie = planTurnSkills({ text: '帮我写周报', pinned: [], follow: false, cards: [left, right] });
  expect(tie.loaded).toHaveLength(0);
  expect(tie.notice).toContain('请说明要用哪一个');
  const blocked = planTurnSkills({ text: '请开始整理知识', pinned: [], follow: false, cards: PRODUCT_SKILLS });
  expect(blocked.loaded).toHaveLength(0);
  expect(blocked.notice).toContain('不会自动执行');
  expect(authorizedWriteTools('请开始整理知识', PRODUCT_SKILLS)).toEqual([]);
  const allowed = planTurnSkills({ text: '确认执行深度知识整理', pinned: [], follow: false, cards: PRODUCT_SKILLS });
  expect(allowed.loaded.map(card => card.name)).toEqual(['knowledge-organize']);
  expect(authorizedWriteTools('确认执行深度知识整理', PRODUCT_SKILLS)).toEqual(['knowledge_organize']);
  expect(workbenchMemoryTools('确认执行深度知识整理', true).map(tool => tool.name)).not.toContain('knowledge_organize');
  expect(workbenchMemoryTools('确认执行深度知识整理', true, ['knowledge_organize']).map(tool => tool.name)).toContain('knowledge_organize');
  const shell = { ...PRODUCT_SKILLS[0]!, name: 'shell-job', displayName: '外部命令', description: '运行命令', triggers: ['运行命令'], tools: ['shell'], supported: false, missingTools: ['shell'], permission: 'external' as const, kind: 'custom' as const, origin: 'custom' as const };
  expect(planTurnSkills({ text: '确认执行外部命令', pinned: [], follow: false, cards: [shell] }).loaded).toHaveLength(0);
  expect(authorizedWriteTools('确认执行外部命令', [shell])).toEqual([]);
  const instructions = await agentInstructions({ engine: {}, config: () => ({}) } as never, { id: 'main', name: '主助手', skills: [], sourceIds: ['default'], readDirectories: [], deliveryFormat: 'docx' } as never, { userText: '确认执行深度知识整理' });
  expect(instructions).toContain('调用 knowledge_organize');
  expect(instructions).toContain('不要另写');
  expect(instructions).not.toContain('不会自动执行');
});

test('模型草稿保留步骤和检查，并去掉不能使用的工具', () => {
  const base = skillDraftFromRequest('帮我创建一个产品需求分析技能');
  expect(base?.steps).toContain('怎么检查');
  expect(base?.steps).toContain('先检索已授权资料');
  const raw = JSON.stringify({ description: '分析产品需求并保存文档', triggers: ['需求分析'], tools: ['knowledge_search', 'shell', 'knowledge_organize'], steps: '先检索已授权资料，再列出需求，最后保存。', checks: '再说需求分析应命中本技能', mutating: true });
  const improved = skillDraftFromModel(raw, base!, '帮我创建一个产品需求分析技能');
  expect(improved?.draft.displayName).toBe('产品需求分析');
  expect(improved?.draft.tools).toEqual(['knowledge_search']);
  expect(improved?.draft.mutating).toBe(false);
  expect(improved?.draft.steps).toContain('怎么检查');
  expect(improved?.notice).toContain('shell');
  expect(improved?.notice).toContain('确认创建这个技能');
  const writing = skillDraftFromModel(JSON.stringify({ description: '启动现有整理', triggers: ['整理知识'], tools: ['knowledge_organize'], steps: '调用现有整理任务。', checks: '任务中心出现任务', mutating: true }), base!, '创建一个整理知识技能，要启动整理');
  expect(writing?.draft.tools).toContain('knowledge_organize');
  expect(writing?.draft.mutating).toBe(true);
});

test('测试模型不负责写技能，正式草稿确认前不落文件', async () => {
  let calls = 0;
  const answer = async () => { calls += 1; return { text: '{"steps":"先检索"}' }; };
  expect(await draftSkillWithModel(answer, 'service-agent:chat', new AbortController().signal, { text: '创建一个技能', catalog: '' })).toBeUndefined();
  expect(calls).toBe(0);
  const dir = root();
  const skills = new SkillCenter(dir, async () => PRODUCT_SKILLS.map(skill => ({ ...skill })));
  const base = skillDraftFromRequest('帮我创建一个产品需求分析技能')!;
  const raw = JSON.stringify({ description: '分析需求并保存', triggers: ['产品需求分析'], tools: ['knowledge_search', 'artifact_save'], steps: '先检索已授权资料，再保存文件。', checks: '再说产品需求分析应命中。' });
  const notice = applyModelSkillDraft(skills, 'conversation-1', raw, base, '帮我创建一个产品需求分析技能', await skills.list());
  expect(notice).toContain('确认创建这个技能');
  expect(readdirSync(dir).includes('user-skills')).toBe(false);
  const pending = JSON.parse(readFileSync(join(dir, 'skill-center.json'), 'utf8')).pending['conversation-1'];
  expect(pending.steps).toContain('怎么检查');
  expect(pending.replaces).toBeUndefined();
  const duplicate = applyModelSkillDraft(skills, 'conversation-2', raw, { ...base, displayName: '周报写作' }, '帮我创建一个周报写作技能', await skills.list());
  expect(duplicate).toBe('已有同名技能');
});

test('按这次的方法先出草稿，纠正后确认才改原技能', async () => {
  const dir = root();
  const store = new WorkbenchStore(dir);
  const service = new WorkbenchService(store, () => [{ id: 'ollama:local', name: '本地', contextWindow: 8192 }], async () => ({ text: '好', model: 'ollama:local', citations: [] }));
  const agent = new WorkbenchAgentStore(store).create({ name: '需求助手', workflow: '先列出风险，再写结论', skills: [], systemPrompt: '你整理需求' });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '先列出风险，再写结论，不要编造' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '按照这次的方法，以后都这么做' });
  await service.settled(conversation.id);
  expect(store.get(conversation.id).messages.at(-1)?.skillNotice).toContain('确认创建这个技能');
  expect(readdirSync(dir).includes('user-skills')).toBe(false);
  service.send(conversation.id, { text: '确认创建这个技能' });
  await service.settled(conversation.id);
  expect(store.get(conversation.id).messages.at(-1)?.savedSkill).toBe('需求助手');
  const skills = new SkillCenter(dir, () => PRODUCT_SKILLS.map(skill => ({ ...skill })));
  const created = (await skills.list()).find(card => card.displayName === '需求助手')!;
  skills.record({ at: new Date().toISOString(), name: created.name, displayName: created.displayName, agentId: agent.id, excerpt: '写需求', status: 'success', result: '已完成' });
  const revision = skills.applyConversation({ conversationId: conversation.id, agentId: agent.id, text: '改进这个技能，步骤改成先列风险', playbook: null, compile: () => { throw new Error('不应重新编译'); } });
  expect(revision.notice).toContain('不会自动改掉原来的技能');
  expect(readdirSync(join(dir, 'user-skills'))).toHaveLength(1);
  const saved = skills.applyConversation({ conversationId: conversation.id, agentId: agent.id, text: '确认创建这个技能', playbook: null, compile: () => { throw new Error('不应重新编译'); } });
  expect(saved.saved).toBe('需求助手');
  expect(saved.notice).toContain('已更新技能');
  expect(readdirSync(join(dir, 'user-skills'))).toHaveLength(1);
  expect(readFileSync(join(dir, 'user-skills', created.name.replace(/^user__/, ''), 'SKILL.md'), 'utf8')).toContain('先列风险');
});
