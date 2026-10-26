import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import type { WorkbenchCitation } from '../shared/workbench';
import { agentHandlers } from '../src/product/workbench/agent-tools';
import { quoteArtifact, quoteArtifactSelection } from '../src/product/workbench/artifact-quote';
import { openArtifactCommand, readWorkbenchArtifact, renumberCitationMarkers, reviseWorkbenchArtifact, saveWorkbenchArtifact } from '../src/product/workbench/files';
import { EVIDENCE_GAP_TEXT } from '../src/product/workbench/playbook';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { compileTaskBrief } from '../src/product/workbench/task-context';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { appendDraft, clearDraftIfUnchanged, draftKey, readDraftMap, writeDraft } from '../admin/src/workbench/draft-store';
import { toolActivityLine } from '../admin/src/workbench/tool-summary';

const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-collab-'));
const conversationId = '00000000-0000-4000-8000-000000000031';
const messageId = '00000000-0000-4000-8000-000000000032';
const original = '第一节 原样\n第二节 很长\n第三节 原样';
const shortened = '第一节 原样\n第二节 短\n第三节 原样';
const budget: WorkbenchCitation = { sourceId: 'default', slug: 'budget', title: '预算依据', snippet: '8800' };
const intro: WorkbenchCitation = { sourceId: 'default', slug: 'intro', title: '背景资料', snippet: '项目背景' };

function world(format: 'markdown' | 'docx' = 'markdown') {
  const directory = root();
  const sourceDir = join(directory, 'knowledge');
  mkdirSync(sourceDir);
  const store = new WorkbenchAgentStore(new WorkbenchStore(join(directory, 'store')));
  const agent = store.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: format, sourceIds: ['default'] });
  return { directory, sourceDir, store, agent };
}

function citeTable(citations: WorkbenchCitation[]) {
  return (row: WorkbenchCitation) => {
    let index = citations.findIndex(item => item.sourceId === row.sourceId && item.slug === row.slug);
    if (index < 0) { citations.push({ sourceId: row.sourceId, slug: row.slug, title: row.title, snippet: row.snippet }); index = citations.length - 1; }
    return index + 1;
  };
}

test('引用编号按出现顺序整段替换，[1] 不会把 [12] 吃掉', () => {
  expect(renumberCitationMarkers('见 [1]，另见 [12]', new Map([[1, 2], [12, 13]]))).toBe('见 [2]，另见 [13]');
});

test('读回带出处的旧稿后，只改第二节，保存下来的编号仍指向原来的资料', async () => {
  const { store, agent, sourceDir } = world();
  const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: sourceDir }] : [{ id: 'default' }] } as never;
  const saved = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: `预算8800 [1]\n${original}`, citations: [budget] });
  const empty: WorkbenchCitation[] = [];
  const handlers = agentHandlers({ store, engine, config: () => ({}) as never }, { agent, userText: '第二节短一点，其他不动', conversationId, messageId: '00000000-0000-4000-8000-000000000033', cite: citeTable(empty), citations: empty, active: () => true });
  const seen = await handlers.get('artifact_read')!.execute({ id: saved.id }, new AbortController().signal) as { content: string; citations: WorkbenchCitation[] };
  expect(seen.content).toContain('预算8800 [1]');
  expect(seen.citations[0]?.slug).toBe('budget');
  expect(empty[0]?.origin).toBe('prior-artifact');
  const revised = await handlers.get('artifact_revise')!.execute({ baseArtifactId: saved.id, baseHash: saved.hash, title: '本周周报', content: seen.content.replace('第二节 很长', '第二节 短') }, new AbortController().signal) as { id: string };
  const next = store.artifact(revised.id);
  expect(next.content).toContain('预算8800 [1]');
  expect(next.content).toContain('第二节 短');
  expect(next.content).toContain('第三节 原样');
  expect(next.citations[0]?.slug).toBe('budget');
  expect(next.citations[0]?.title).toBe('预算依据');
  expect(readFileSync(next.path, 'utf8')).toContain('[1] 预算依据 — default/budget');
});

test('本轮已经有别的资料占 [1] 时，旧稿的预算出处会改用下一个编号', async () => {
  const { store, agent, sourceDir } = world();
  const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: sourceDir }] : [{ id: 'default' }] } as never;
  const saved = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: `预算8800 [1]\n${original}`, citations: [budget] });
  const turn: WorkbenchCitation[] = [{ ...intro }];
  const handlers = agentHandlers({ store, engine, config: () => ({}) as never }, { agent, userText: '第二节短一点，其他不动', conversationId, messageId: '00000000-0000-4000-8000-000000000034', cite: citeTable(turn), citations: turn, active: () => true });
  const seen = await handlers.get('artifact_read')!.execute({ id: saved.id }, new AbortController().signal) as { content: string };
  expect(seen.content).toContain('预算8800 [2]');
  expect(seen.content).not.toContain('预算8800 [1]');
  const revised = await handlers.get('artifact_revise')!.execute({ baseArtifactId: saved.id, baseHash: saved.hash, title: '本周周报', content: seen.content.replace('第二节 很长', '第二节 短') }, new AbortController().signal) as { id: string };
  const next = store.artifact(revised.id);
  expect(next.citations[0]?.slug).toBe('intro');
  expect(next.citations[1]?.slug).toBe('budget');
  expect(next.citations[1]?.origin).toBe('prior-artifact');
  expect(next.citations[0]?.origin).toBeUndefined();
  expect(next.content).toContain('预算8800 [2]');
  expect(readFileSync(next.path, 'utf8')).toContain('[2] 预算依据 — default/budget');
  expect(readFileSync(next.path, 'utf8')).toContain('[1] 背景资料 — default/intro');
});

test('重试时再次读取旧稿，会按本轮已有资料重新编号，不会把预算配到背景上', async () => {
  const { store, agent } = world();
  const plain = store.create({ name: '整理助手', deliveryFormat: 'markdown', sourceIds: ['default'] });
  const saved = await saveWorkbenchArtifact(store, { agent: plain, conversationId, messageId, title: '本周周报', content: `预算8800 [1]\n${original}`, citations: [budget] });
  let captured: { content?: string; citations?: Array<WorkbenchCitation & { citation?: number }> } | undefined;
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async () => ({ results: [] }) as never,
    answer: async () => { throw new Error('这条路径应走工具，不应直接回答'); },
    loop: (async (request: { toolHandlers: Map<string, { execute: (raw: unknown, signal: AbortSignal, context?: { toolCallId: string }) => Promise<unknown> }> }) => {
      captured = await request.toolHandlers.get('artifact_read')!.execute({ id: saved.id }, new AbortController().signal, { toolCallId: 'again' }) as typeof captured;
      return { stopReason: 'end', messages: [] };
    }) as never,
  }, undefined, { store, engine: {}, config: () => ({}) } as never);
  const result = await answer({
    agent: plain, model: 'm', knowledge: true, sourceId: 'default', conversationId, messageId: '00000000-0000-4000-8000-000000000035',
    priorCitations: [{ ...intro }],
    task: { id: 'task-read', goal: '核对背景', constraints: [], updatedAt: '' },
    settledTools: [{ id: 'old-read', name: 'artifact_read', input: JSON.stringify({ id: saved.id }), status: 'complete', startedAt: '', completedAt: '', output: JSON.stringify({ content: `预算8800 [1]\n${original}`, title: '本周周报', revision: 1, citations: [{ ...budget, citation: 1 }] }) }],
    messages: [{ id: 'u', role: 'user', text: '缩短第二段', status: 'complete', createdAt: '' }],
    signal: new AbortController().signal, progress: () => {},
  });
  expect(captured?.content).toContain('预算8800 [2]');
  expect(captured?.content).not.toContain('预算8800 [1]');
  expect(captured?.citations?.[0]?.slug).toBe('budget');
  expect(captured?.citations?.[0]?.citation).toBe(2);
  expect(result.citations.find(item => item.slug === 'intro')?.origin).toBeUndefined();
  expect(result.citations.find(item => item.slug === 'budget')?.origin).toBe('prior-artifact');
});

test('只带着旧稿引用去写周报，仍算本期没有新资料，不把旧稿当成这期证据', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  let firstId = '';
  let revisedId = '';
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async input => {
    if (!firstId) {
      const artifact = await saveWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, title: '本周周报', content: `预算8800 [1]\n${original}`, citations: [{ ...budget, origin: 'prior-artifact' }] });
      firstId = artifact.id;
      return { text: '已保存', model: 'local', citations: [] };
    }
    const base = agents.artifact(input.task!.currentArtifactId!);
    const artifact = await reviseWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, baseArtifactId: base.id, baseHash: base.hash, title: '本周周报', content: `预算8800 [1]\n${shortened}`, citations: [{ ...budget, origin: 'prior-artifact' }] });
    revisedId = artifact.id;
    return { text: '改好了', model: 'local', citations: [{ ...budget, origin: 'prior-artifact' }] };
  });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报', knowledge: false });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).task?.currentArtifactId).toBe(firstId);
  service.send(conversation.id, { text: '第二节短一点，其他不动', knowledge: true });
  await service.settled(conversation.id);
  const edited = service.get(conversation.id);
  expect(edited.messages.at(-1)?.text).toBe(EVIDENCE_GAP_TEXT);
  expect(edited.messages.at(-1)?.artifacts ?? []).toHaveLength(0);
  expect(edited.task?.currentArtifactId).toBe(firstId);
  expect(agents.artifact(revisedId).content).toContain('第二节 短');
});

test('文件已经写成新版本后模型失败，重试仍指向这一版，且不会再写一份', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  let firstId = '';
  let revisedId = '';
  let reviseCalls = 0;
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async input => {
    if (!firstId) {
      const artifact = await saveWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, title: '本周周报', content: original, citations: [] });
      firstId = artifact.id;
      return { text: '已保存', model: 'local', citations: [] };
    }
    if (input.settledTools?.some(call => call.name === 'artifact_revise' && call.status === 'complete')) return { text: '第二节已经缩短', model: 'local', citations: [] };
    reviseCalls += 1;
    const base = agents.artifact(input.task!.currentArtifactId!);
    const artifact = await reviseWorkbenchArtifact(agents, { agent, conversationId: input.conversationId!, messageId: input.messageId!, baseArtifactId: base.id, baseHash: base.hash, title: '本周周报', content: shortened, citations: [] });
    revisedId = artifact.id;
    const now = new Date().toISOString();
    input.onTool?.({ id: 'revise-1', name: 'artifact_revise', input: JSON.stringify({ baseArtifactId: base.id, baseHash: base.hash, title: '本周周报', content: shortened }), status: 'complete', startedAt: now, completedAt: now, output: JSON.stringify({ id: artifact.id, saved: true, revision: artifact.revision, title: artifact.title }) });
    throw new Error('后续模型请求失败');
  });
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报' });
  await service.settled(conversation.id);
  service.send(conversation.id, { text: '第二节短一点，其他不动' });
  await service.settled(conversation.id);
  const failed = service.get(conversation.id);
  expect(failed.messages.at(-1)?.status).toBe('error');
  expect(failed.messages.at(-1)?.error).toContain('后续模型请求失败');
  expect(failed.messages.at(-1)?.artifacts ?? []).toHaveLength(0);
  expect(failed.task?.currentArtifactId).toBe(revisedId);
  expect(agents.artifacts().filter(item => item.parentId === firstId)).toHaveLength(1);
  service.send(conversation.id, { retry: true });
  await service.settled(conversation.id);
  const retried = service.get(conversation.id);
  expect(retried.messages.at(-1)?.status).toBe('complete');
  expect(retried.messages.at(-1)?.artifacts?.[0]?.id).toBe(revisedId);
  expect(retried.messages.at(-1)?.artifacts?.[0]?.revision).toBe(2);
  expect(retried.task?.currentArtifactId).toBe(revisedId);
  expect(reviseCalls).toBe(1);
  expect(agents.artifacts().filter(item => item.parentId === firstId)).toHaveLength(1);
  const restarted = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async () => ({ text: '好', model: 'local', citations: [] }));
  const pointer = restarted.get(conversation.id).task?.currentArtifactId;
  expect(pointer).toBe(revisedId);
  const base = agents.artifact(pointer!);
  const third = await reviseWorkbenchArtifact(agents, { agent, conversationId: conversation.id, messageId: '00000000-0000-4000-8000-000000000036', baseArtifactId: base.id, baseHash: base.hash, title: '本周周报', content: '第一节 原样\n第二节 更短\n第三节 原样', citations: [] });
  expect(third.revision).toBe(3);
  expect(third.parentId).toBe(revisedId);
});

test('没说换格式时，后一版沿用原稿格式，不退回助手默认的 Word', async () => {
  const { store, agent } = world('docx');
  const saved = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: original, citations: [], format: 'markdown' });
  expect(saved.format).toBe('markdown');
  const revised = await reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000037', baseArtifactId: saved.id, baseHash: saved.hash, title: '本周周报', content: shortened, citations: [] });
  expect(revised.format).toBe('markdown');
  expect(revised.path.endsWith('.md')).toBe(true);
  expect(readFileSync(revised.path, 'utf8')).toContain('第二节 短');
  const word = await reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000038', baseArtifactId: revised.id, baseHash: revised.hash, title: '本周周报', content: shortened, citations: [], format: 'docx' });
  expect(word.format).toBe('docx');
  expect(word.path.endsWith('.docx')).toBe(true);
  const fresh = await saveWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000039', title: '另一份', content: '新文件', citations: [] });
  expect(fresh.format).toBe('docx');
});

test('还没发布的私有文件被人改过时，读取会标明冲突，修订不会沿用过期正文', async () => {
  const { store, agent } = world();
  const saved = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: original, citations: [] });
  expect(saved.publishedPath).toBeUndefined();
  writeFileSync(saved.path, '用户手工修改后的内容');
  const seen = readWorkbenchArtifact(store, { agentId: agent.id, conversationId, artifactId: saved.id });
  expect(seen.conflict).toBe(true);
  expect(seen.content).toContain('第二节 很长');
  expect(seen.note).toContain('私有成果文件');
  await expect(reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000040', baseArtifactId: saved.id, baseHash: saved.hash, title: '本周周报', content: shortened, citations: [] })).rejects.toThrow('成果文件已被外部修改，未覆盖');
  expect(readFileSync(saved.path, 'utf8')).toBe('用户手工修改后的内容');
  expect(store.artifacts()).toHaveLength(1);
  unlinkSync(saved.path);
  const missing = readWorkbenchArtifact(store, { agentId: agent.id, conversationId, artifactId: saved.id });
  expect(missing.conflict).toBe(true);
  expect(missing.note).toContain('文件缺失');
  await expect(reviseWorkbenchArtifact(store, { agent, conversationId, messageId: '00000000-0000-4000-8000-000000000041', baseArtifactId: saved.id, baseHash: saved.hash, title: '本周周报', content: shortened, citations: [] })).rejects.toThrow('已保存成果的文件缺失');
});

test('创建助手要明确确认；多份成果时，单独说可以不会改文件', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  let calls = 0;
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async input => {
    calls += 1;
    if (input.messages.at(-1)?.text === '确认创建') {
      const created = agents.create({ name: '报销助手' });
      input.onTool?.({ id: 'create', name: 'assistant_create', input: '{}', status: 'complete', startedAt: '', output: JSON.stringify({ id: created.id, created: true }) });
    }
    return { text: '先说明方案', model: 'local', citations: [] };
  });
  const conversation = service.create({ knowledge: false });
  service.send(conversation.id, { text: '创建一个报销助手，负责整理发票' });
  await service.settled(conversation.id);
  expect(calls).toBe(1);
  expect(service.get(conversation.id).pending?.kind).toBe('assistant-create');
  service.send(conversation.id, { text: '可以' });
  await service.settled(conversation.id);
  expect(calls).toBe(1);
  expect(service.get(conversation.id).messages.at(-1)?.text).toContain('确认创建');
  expect(service.get(conversation.id).pending?.kind).toBe('assistant-create');
  service.send(conversation.id, { text: '确认创建' });
  await service.settled(conversation.id);
  expect(calls).toBe(2);
  expect(service.get(conversation.id).pending).toBeUndefined();
  expect(service.get(conversation.id).usedConfirm).toBeTruthy();
  service.send(conversation.id, { text: '确认创建' });
  await service.settled(conversation.id);
  expect(calls).toBe(2);
  expect(service.get(conversation.id).messages.at(-1)?.text).toContain('已经用过');
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  const reports = service.create({ assistantId: agent.id, knowledge: false });
  service.send(reports.id, { text: '生成本周周报' });
  await service.settled(reports.id);
  const before = agents.artifacts().length;
  const budgetReport = await saveWorkbenchArtifact(agents, { agent, conversationId: reports.id, messageId: '00000000-0000-4000-8000-000000000042', title: '预算周报', content: original, citations: [] });
  await saveWorkbenchArtifact(agents, { agent, conversationId: reports.id, messageId: '00000000-0000-4000-8000-000000000043', title: '项目方案', content: '方案正文', citations: [] });
  const carried = service.get(reports.id);
  if (carried.task) delete carried.task.currentArtifactId;
  workbench.save(carried);
  const callsBeforeChoice = calls;
  service.send(reports.id, { text: '改第二节' });
  await service.settled(reports.id);
  expect(calls).toBe(callsBeforeChoice);
  expect(service.get(reports.id).messages.at(-1)?.text).toContain('预算周报');
  expect(service.get(reports.id).messages.at(-1)?.text).toContain('项目方案');
  expect(agents.artifacts()).toHaveLength(before + 2);
  service.send(reports.id, { text: '可以' });
  await service.settled(reports.id);
  expect(calls).toBe(callsBeforeChoice);
  expect(service.get(reports.id).messages.at(-1)?.text).toContain('单独说可以不会改文件');
  expect(agents.artifacts()).toHaveLength(before + 2);
  service.send(reports.id, { text: '就改预算周报' });
  await service.settled(reports.id);
  expect(calls).toBe(callsBeforeChoice + 1);
  expect(service.get(reports.id).task?.currentArtifactId).toBe(budgetReport.id);
  expect(service.get(reports.id).pending).toBeUndefined();
});

test('空报创建成功不会写入助手，并提示确认后才出现在列表', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const dump = '写作助手已创建成功，可用于日常写作任务。\n\n**创建结果**\n- 名称：写作助手\n- ID：`1387cc99-e12e-498a-a80c-43a0006966f3`（revision 1）\n- 知识来源：default、outputs';
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async () => ({ text: dump, model: 'local', citations: [] }));
  const conversation = service.create({ knowledge: false });
  service.send(conversation.id, { text: '创建一个写作的助手，用于写作。' });
  await service.settled(conversation.id);
  const reply = service.get(conversation.id).messages.at(-1);
  expect(agents.list().some(agent => agent.name === '写作助手')).toBe(false);
  expect(reply?.text).toContain('确认创建');
  expect(reply?.text).toContain('还没有真正创建');
  expect(reply?.text).not.toContain('1387cc99');
  expect(service.get(conversation.id).pending?.kind).toBe('assistant-create');
  expect(service.list().find(row => row.id === conversation.id)?.activity).toContain('还没有真正创建');
});

test('空报保存文件、交任务和整理完成时不会留下假回执', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const hash = '26befafca55b0bf0a2b5228ec643710999d4f944aed5c0078e8e4cdb95a3fc10';
  const replies = [
    `周报已生成并保存为 Word 文件。\n**下载**：/admin/api/workbench/artifacts/${hash}/download\n本周完成了评审。`,
    '已把任务交给报销助手，请在它的对话里看进展。',
    '知识整理已经完成，可以去知识库查看。',
  ];
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async () => ({ text: replies.shift() ?? '', model: 'local', citations: [] }));
  const conversation = service.create({ knowledge: false });
  service.send(conversation.id, { text: '把这周周报存成 Word' });
  await service.settled(conversation.id);
  const saved = service.get(conversation.id).messages.at(-1);
  expect(agents.artifacts()).toHaveLength(0);
  expect(saved?.text).toContain('还没有真正保存');
  expect(saved?.text).toContain('本周完成了评审');
  expect(saved?.text).not.toContain(hash);
  expect(saved?.artifacts ?? []).toHaveLength(0);
  service.send(conversation.id, { text: '把这件事交给报销助手' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.text).toContain('还没有真正交给');
  service.send(conversation.id, { text: '现在知识库里有什么进展' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.text).toContain('还没有提交到任务中心');
});

test('最初那张图在很多轮继续之后仍留在任务材料里，核对时不会把后面的图都读一遍', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000, vision: true }], async () => ({ text: '好', model: 'local', citations: [] }));
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  service.send(conversation.id, { text: '生成本周周报', attachments: [{ name: '最初现场.png', mime: 'image/png', data: Buffer.from('png').toString('base64') }] });
  await service.settled(conversation.id);
  const firstMessageId = service.get(conversation.id).messages[0]?.id;
  const firstAttachmentId = service.get(conversation.id).messages[0]?.attachments?.[0]?.id;
  expect(firstAttachmentId).toBeTruthy();
  for (let index = 0; index < 12; index += 1) {
    service.send(conversation.id, { text: '继续' });
    await service.settled(conversation.id);
  }
  const task = service.get(conversation.id).task;
  expect(task?.materials?.some(item => item.name === '最初现场.png' && item.ref === firstAttachmentId)).toBe(true);
  expect(task?.sources?.some(item => item.messageId === firstMessageId && item.note === '提出任务')).toBe(true);
  expect(compileTaskBrief(task, false)).toContain('最初现场.png');
  const images = ['图1.png', '图2.png', '图3.png', '图4.png', '图5.png'].map((name, index) => ({
    id: `00000000-0000-4000-8000-${String(50 + index).padStart(12, '0')}`,
    role: 'user' as const,
    text: `第 ${index + 1} 张`,
    createdAt: '2026-10-17T00:00:00.000Z',
    status: 'complete' as const,
    attachments: [{ id: `00000000-0000-4000-8000-${String(60 + index).padStart(12, '0')}`, name, mime: 'image/png', route: 'vision' as const, included: 0, preview: 'data:image/png;base64,YQ==' }],
  }));
  const pictureConversation = service.create({ assistantId: agent.id, knowledge: false });
  const seeded = service.get(pictureConversation.id);
  seeded.messages = images;
  seeded.task = { id: 'pics', goal: '核对图片', constraints: [], updatedAt: '2026-10-17T00:00:00.000Z', materials: [{ messageId: images[0]!.id, kind: 'attachment', ref: images[0]!.attachments![0]!.id, name: '图1.png' }] };
  workbench.save(seeded);
  const seen = new Set<string>();
  workbench.readAttachment = (_conversationId, attachmentId) => { seen.add(attachmentId); return Buffer.from('png'); };
  service.send(pictureConversation.id, { text: '按最初那张图核对' });
  await service.settled(pictureConversation.id);
  expect([...seen]).toEqual([images[0]!.attachments![0]!.id]);
});

test('周报任务只把已保存的偏好带进回答，不把事件当成本期资料', async () => {
  let system = '';
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async () => ({ results: [] }) as never,
    recall: async () => [
      { sourceId: 'default', slug: 'pref', title: '对话记忆 · 偏好', snippet: '喜欢短句', kind: 'memory' as const, factId: 1 },
      { sourceId: 'default', slug: 'event', title: '已保存事实 · 事件', snippet: '上周报销已提交', kind: 'memory' as const, factId: 2 },
    ],
    answer: async input => { system = input.system ?? ''; return { text: '好', model: 'm', stopReason: 'end' } as never; },
  });
  const result = await answer({
    model: 'm', knowledge: true, sourceId: 'default', signal: new AbortController().signal, progress: () => {}, contextWindow: 8192,
    task: { id: 'task-week', goal: '生成本周周报', constraints: [], updatedAt: '' },
    messages: [{ id: 'u', role: 'user', text: '继续', status: 'complete', createdAt: '' }],
  });
  expect(system).toContain('喜欢短句');
  expect(system).toContain('不是知识库里的本期资料');
  expect(system).not.toContain('上周报销已提交');
  expect(result.citations.some(item => item.slug === 'event' || item.slug === 'pref')).toBe(false);
});

test('选中的段落和整份成果都能带上编号；草稿按助手分开，发送中改过的字不会被清掉', () => {
  const quote = quoteArtifactSelection({ id: 'artifact-1', revision: 2, title: '本周周报', content: original, selected: '第二节 很长' });
  expect(quote.text).toContain('artifact-1');
  expect(quote.text).toContain('第 2 版');
  expect(quote.text).toContain('第二节 很长');
  expect(quote.conversationId).toBe('');
  expect(() => quoteArtifactSelection({ id: 'artifact-1', title: '本周周报', content: original, selected: '这段不在正文里' })).toThrow('选中的文字不在这份成果里');
  expect(quoteArtifact({ id: 'artifact-1', revision: 2, title: '本周周报' }).text).toContain('没点名的段落保持原样');
  const line = '第二节 **预算 8800** [1]';
  const formatted = quoteArtifactSelection({ id: 'artifact-1', revision: 3, title: '预算周报', content: line, selected: '第二节 预算 8800 1', citationCount: 1 });
  expect(formatted.text).toContain('第二节 **预算 8800** [1]');
  expect(formatted.text).toContain('第 1–19 字');
  const doubled = `${line}\n\n${line}`;
  const second = quoteArtifactSelection({ id: 'artifact-1', revision: 3, title: '预算周报', content: doubled, selected: '第二节 预算 8800 1', occurrence: 1, citationCount: 1 });
  expect(second.text).toContain('第 22–40 字');
  expect(second.text).toContain(line);
  const partial = quoteArtifactSelection({ id: 'artifact-1', title: '预算周报', content: line, selected: '预算', citationCount: 1 });
  expect(partial.text.endsWith('\n预算')).toBe(true);
  expect(partial.text).not.toContain('**');
  let owned = writeDraft({}, 'conversation-main', '主助手原来的字', 'main', 'conversation-main', 'token-main');
  owned = writeDraft(owned, 'conversation-writer', '文稿里已有的字', 'writer', 'conversation-writer', 'token-writer');
  const target = quoteArtifact({ id: 'artifact-9', revision: 2, title: '产品架构', assistantId: 'writer', conversationId: 'conversation-writer' });
  owned = appendDraft(owned, draftKey(target.conversationId, target.assistantId), target.text, target.assistantId, target.conversationId);
  expect(owned['conversation-main']?.text).toBe('主助手原来的字');
  expect(owned['conversation-writer']?.text.startsWith('文稿里已有的字\n')).toBe(true);
  expect(owned['conversation-writer']?.text).toContain('artifact-9');
  expect(owned['conversation-writer']?.token).toBe('token-writer');
  let drafts = writeDraft({}, 'conversation-a', '周报草稿', 'assistant-a', 'conversation-a', 'token-a');
  drafts = writeDraft(drafts, 'conversation-a', '周报草稿已改', 'assistant-a', 'conversation-a');
  expect(clearDraftIfUnchanged(drafts, 'conversation-a', 'token-a', '周报草稿')['conversation-a']?.text).toBe('周报草稿已改');
  expect(clearDraftIfUnchanged(drafts, 'conversation-a', 'token-a', '周报草稿已改')['conversation-a']?.text).toBe('');
  drafts = writeDraft(drafts, 'new:assistant-b', '报销草稿', 'assistant-b', '');
  expect(drafts['conversation-a']?.text).toBe('周报草稿已改');
  expect(drafts['new:assistant-b']?.assistantId).toBe('assistant-b');
  expect(readDraftMap(JSON.stringify(drafts))['new:assistant-b']?.text).toBe('报销草稿');
  expect(toolActivityLine('artifact_list', JSON.stringify({ results: [{}, {}] }))).toBe('已有 2 份成果');
  expect(toolActivityLine('artifact_read', JSON.stringify({ title: '本周周报', revision: 2, content: '正文' }))).toBe('已读第 2 版 本周周报');
  expect(toolActivityLine('artifact_revise', JSON.stringify({ saved: true, revision: 2, title: '本周周报' }))).toContain('第 2 版');
  expect(toolActivityLine('local_files', JSON.stringify({ results: [{}] }))).toBe('找到 1 个文件或目录');
  expect(toolActivityLine('local_read', JSON.stringify({ title: '空文件', content: '' }))).toContain('没有可核对的文字');
  expect(toolActivityLine('knowledge_search', JSON.stringify({ results: [] }))).toBe('');
});

test('打开和定位只使用已保存成果的路径，模型传来的路径不会被执行', async () => {
  const { store, agent } = world();
  const saved = await saveWorkbenchArtifact(store, { agent, conversationId, messageId, title: '本周周报', content: original, citations: [] });
  const calls: Array<{ path: string; action: string }> = [];
  const opened = openArtifactCommand({ action: 'reveal' }, store, saved.id, (path, action) => calls.push({ path, action }));
  expect(calls).toEqual([{ path: realpathSync(saved.path), action: 'reveal' }]);
  expect(opened.path).toBe(realpathSync(saved.path));
  expect(() => openArtifactCommand({ action: 'open', path: 'C:\\不该打开的路径' }, store, saved.id, () => { throw new Error('不应打开'); })).toThrow('只能按成果编号打开');
  expect(() => openArtifactCommand({}, store, saved.id, () => { throw new Error('不应打开'); })).toThrow('打开方式无效');
  const workbench = readFileSync(new URL('../admin/src/workbench/Workbench.tsx', import.meta.url), 'utf8');
  const artifacts = readFileSync(new URL('../admin/src/workbench/Artifacts.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../admin/src/workbench/AgentSettings.tsx', import.meta.url), 'utf8');
  const activity = readFileSync(new URL('../admin/src/workbench/ToolActivity.tsx', import.meta.url), 'utf8');
  const message = readFileSync(new URL('../admin/src/workbench/Message.tsx', import.meta.url), 'utf8');
  expect(workbench).toContain('clearDraftIfUnchanged');
  expect(workbench).toContain('DRAFT_STORAGE_KEY');
  expect(workbench).toContain('appendDraft');
  expect(workbench).toContain('wb.select(target.conversationId)');
  expect(artifacts).toContain("action: 'reveal'");
  expect(artifacts).toContain('引用选中文字');
  expect(artifacts).toContain('sourceMap');
  expect(artifacts).toContain('conversationId: selected.conversationId');
  expect(message).toContain('quoteArtifact({ id: item.id, revision: item.revision, title: item.title }).text');
  expect(settings).toContain('chooseDirectory');
  expect(settings).toContain('可读取的本地目录');
  expect(activity).toContain('toolActivityLine');
  expect(activity).toContain('搜索知识');
  expect(message).toContain('按这份改');
});

test('点名靠后的历史图片时，交给模型的就是这张；换任务后最初那张只取当前任务里的图', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  agents.replace({ ...agents.get(agent.id), context: { maxMessages: 2, threshold: 0.8, summaryModel: '' } });
  const seen: string[] = [];
  let shown: string[] = [];
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000, vision: true }], async input => {
    shown = (input.visualAttachments ?? []).map(item => item.name);
    for (const message of input.messages) for (const item of message.attachments ?? []) if (item.route === 'vision' && (item.data || item.preview)) shown.push(item.name);
    return { text: '看到了', model: 'local', citations: [] };
  }, async () => '早期摘要');
  workbench.readAttachment = (_conversationId, attachmentId) => { seen.push(attachmentId); return Buffer.from('png'); };
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const images = Array.from({ length: 6 }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(101 + index).padStart(12, '0')}`;
    const attachmentId = `00000000-0000-4000-8000-${String(201 + index).padStart(12, '0')}`;
    return {
      id,
      role: 'user' as const,
      text: `第 ${index + 1} 张`,
      createdAt: '2026-10-17T00:00:00.000Z',
      status: 'complete' as const,
      attachments: [{ id: attachmentId, name: `图${index + 1}.png`, mime: 'image/png', route: 'vision' as const, included: 0, preview: 'data:image/png;base64,YQ==' }],
    };
  });
  const seeded = service.get(conversation.id);
  seeded.messages = [...images, { id: '00000000-0000-4000-8000-000000000199', role: 'assistant', text: '先记下这六张', createdAt: '2026-10-17T00:00:00.000Z', status: 'complete' }];
  seeded.task = {
    id: 'pics',
    goal: '核对图片',
    constraints: [],
    updatedAt: '2026-10-17T00:00:00.000Z',
    materials: images.map(message => ({ messageId: message.id, kind: 'attachment' as const, ref: message.attachments[0]!.id, name: message.attachments[0]!.name })),
  };
  workbench.save(seeded);
  service.send(conversation.id, { text: '继续，按图6.png核对' });
  await service.settled(conversation.id);
  expect(shown).toEqual(['图6.png']);
  expect(new Set(seen)).toEqual(new Set([images[5]!.attachments[0]!.id]));
  service.send(conversation.id, { text: '这次改做报销' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).task?.materials).toBeUndefined();
  expect(service.get(conversation.id).task?.goal).not.toBe('核对图片');
  service.send(conversation.id, { text: '看新图', attachments: [{ name: '新图.png', mime: 'image/png', data: Buffer.from('new').toString('base64') }] });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).task?.materials?.map(item => item.name)).toEqual(['新图.png']);
  seen.length = 0;
  service.send(conversation.id, { text: '按最初那张图核对' });
  await service.settled(conversation.id);
  expect(shown).toEqual(['新图.png']);
  expect(seen.some(id => images.some(message => message.attachments[0]?.id === id))).toBe(false);
});

test('创建文稿不会变成待确认的助手；取消和清理之后，可以仍会继续回答', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const writer = agents.create({ name: '文稿助手', workflow: '按资料写文稿', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  let calls = 0;
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async () => { calls += 1; return { text: '继续写文稿', model: 'local', citations: [] }; });
  const reports = service.create({ assistantId: writer.id, knowledge: false });
  service.send(reports.id, { text: '创建一份文稿，介绍产品架构' });
  await service.settled(reports.id);
  expect(calls).toBe(1);
  expect(service.get(reports.id).pending).toBeUndefined();
  service.send(reports.id, { text: '不用创建助手，接着精简文稿' });
  await service.settled(reports.id);
  expect(calls).toBe(2);
  expect(service.get(reports.id).pending).toBeUndefined();
  service.send(reports.id, { text: '可以' });
  await service.settled(reports.id);
  expect(calls).toBe(3);
  expect(service.get(reports.id).messages.at(-1)?.text).toBe('继续写文稿');
  const blocked = service.get(reports.id);
  blocked.pending = { kind: 'assistant-create', fingerprint: 'old', prompt: '创建一个文稿助手', createdAt: '2026-09-01T00:00:00.000Z', assistantRevision: agents.get(writer.id).revision };
  blocked.usedConfirm = 'old';
  workbench.save(blocked);
  const cleared = service.clearTaskContext(reports.id);
  expect(cleared.pending).toBeUndefined();
  expect(cleared.usedConfirm).toBeUndefined();
  service.send(reports.id, { text: '可以' });
  await service.settled(reports.id);
  expect(calls).toBe(4);
  expect(service.get(reports.id).messages.at(-1)?.text).toBe('继续写文稿');
  const main = service.create({ knowledge: false });
  service.send(main.id, { text: '创建一个报销助手，负责整理发票' });
  await service.settled(main.id);
  expect(calls).toBe(5);
  expect(service.get(main.id).pending?.kind).toBe('assistant-create');
  service.send(main.id, { text: '不用创建助手，接着精简文稿' });
  await service.settled(main.id);
  expect(calls).toBe(6);
  expect(service.get(main.id).pending).toBeUndefined();
  service.send(main.id, { text: '可以' });
  await service.settled(main.id);
  expect(calls).toBe(7);
  expect(service.get(main.id).messages.at(-1)?.text).toBe('继续写文稿');
});

test('没有方案版本的旧创建确认不会被消费，换任务后也不再拦住回答', async () => {
  const directory = root();
  const workbench = new WorkbenchStore(join(directory, 'workbench'));
  const agents = new WorkbenchAgentStore(workbench);
  const agent = agents.create({ name: '周报助手', workflow: '先查资料再写周报', skills: ['weekly-report'], deliveryFormat: 'markdown', sourceIds: ['default'] });
  let calls = 0;
  const service = new WorkbenchService(workbench, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async () => { calls += 1; return { text: '继续处理', model: 'local', citations: [] }; });
  const main = service.create({ knowledge: false });
  const stale = service.get(main.id);
  stale.pending = { kind: 'assistant-create', fingerprint: 'stale-fingerprint', prompt: '创建一个报销助手', createdAt: '2026-09-01T00:00:00.000Z' };
  workbench.save(stale);
  service.send(main.id, { text: '确认创建' });
  await service.settled(main.id);
  expect(calls).toBe(1);
  expect(service.get(main.id).usedConfirm).toBeUndefined();
  expect(service.get(main.id).pending).toBeUndefined();
  expect(service.get(main.id).messages.at(-1)?.text).toBe('继续处理');
  const mismatched = service.get(main.id);
  mismatched.pending = { kind: 'assistant-create', fingerprint: 'other', prompt: '创建一个报销助手', createdAt: '2026-09-01T00:00:00.000Z', assistantRevision: 9 };
  workbench.save(mismatched);
  service.send(main.id, { text: '确认创建' });
  await service.settled(main.id);
  expect(calls).toBe(2);
  expect(service.get(main.id).usedConfirm).toBeUndefined();
  const reports = service.create({ assistantId: agent.id, knowledge: false });
  service.send(reports.id, { text: '生成本周周报' });
  await service.settled(reports.id);
  const open = service.get(reports.id);
  open.pending = { kind: 'assistant-create', fingerprint: 'task', prompt: '创建一个助手', createdAt: '2026-09-01T00:00:00.000Z', assistantRevision: agents.get(agent.id).revision, taskId: open.task?.id };
  workbench.save(open);
  service.send(reports.id, { text: '这次改做报销' });
  await service.settled(reports.id);
  expect(service.get(reports.id).pending).toBeUndefined();
  expect(service.get(reports.id).messages.at(-1)?.text).toBe('继续处理');
  expect(calls).toBe(4);
});
