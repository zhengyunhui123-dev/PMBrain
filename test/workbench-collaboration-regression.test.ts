import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownArticle } from '../admin/src/pages/Documentation';
import { agentHandlers } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { quoteArtifactSelection } from '../src/product/workbench/artifact-quote';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

const adminRequire = createRequire(new URL('../admin/package.json', import.meta.url));
const { createElement } = adminRequire('react');
const { renderToStaticMarkup } = adminRequire('react-dom/server');
const root = () => mkdtempSync(join(tmpdir(), 'pmbrain-collaboration-regression-'));

test('只看图6时最终请求只含图6；本轮新图仍会发送，完整历史图片不变', async () => {
  const store = new WorkbenchStore(root());
  const agents = new WorkbenchAgentStore(store);
  const agent = agents.create({ name: '图片助手', deliveryFormat: 'markdown' });
  const sent: string[][] = [];
  const answer = knowledgeWorkbenchAnswer({} as never, {
    search: async () => ({ results: [] }) as never,
    answer: async input => {
      sent.push(input.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content.flatMap(block => block.type === 'image' ? [Buffer.from(String(block.image).split(',')[1]!, 'base64').toString()] : [])));
      return { text: '已核对', model: 'local', stopReason: 'end' } as never;
    },
  });
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 128000, vision: true }], answer);
  const conversation = service.create({ assistantId: agent.id, knowledge: false });
  const seeded = service.get(conversation.id);
  const pictures = Array.from({ length: 6 }, (_, index) => ({
    id: randomUUID(), role: 'user' as const, status: 'complete' as const, text: `材料${index + 1}`, createdAt: '',
    attachments: [{ id: randomUUID(), name: `图${index + 1}.png`, mime: 'image/png', route: 'vision' as const, included: 0, preview: `data:image/png;base64,${Buffer.from(`旧预览${index + 1}`).toString('base64')}` }],
  }));
  seeded.messages = pictures;
  seeded.task = { id: randomUUID(), goal: '核对图片', constraints: [], updatedAt: '', materials: pictures.map(message => ({ messageId: message.id, kind: 'attachment', ref: message.attachments[0]!.id, name: message.attachments[0]!.name })) };
  store.save(seeded);
  store.readAttachment = (_conversationId, id) => Buffer.from(id === pictures[5]!.attachments[0]!.id ? '图6原图' : '本轮新图');
  service.send(conversation.id, { text: '继续，只看图6.png' });
  await service.settled(conversation.id);
  expect(sent[0]).toEqual(['图6原图']);
  service.send(conversation.id, { text: '继续，把图6.png和这张新图对照', attachments: [{ name: '本轮新图.png', mime: 'image/png', data: Buffer.from('new-image').toString('base64') }] });
  await service.settled(conversation.id);
  expect(sent[1]).toEqual(['图6原图', '本轮新图']);
  const history = service.get(conversation.id).messages.slice(0, 6);
  expect(history.map(message => message.attachments?.[0]?.route)).toEqual(Array(6).fill('vision'));
  expect(history.every(message => message.attachments?.[0]?.preview)).toBe(true);
});

test('表格与代码块的可见文字能按渲染位置引用回原稿，保留转义符号', () => {
  const markdown = '| 项目 | 金额 |\n| --- | --- |\n| 甲\\|乙 | 8800 |\n\n```ts\nconst budget = 8800;\n```';
  const html = renderToStaticMarkup(createElement(MarkdownArticle, { markdown, sourceMap: true })) as string;
  const mapping = (text: string) => {
    const cell = [...html.matchAll(/<td>(.*?)<\/td>/gs)].find(match => match[1]!.replace(/<[^>]+>/g, '') === text)?.[1] ?? html;
    const tags = [...cell.matchAll(/<[^>]+data-source-start="(\d+)"[^>]+data-source-end="(\d+)"[^>]*>([^<]*)</g)];
    const exact = tags.find(match => match[3] === text);
    const first = exact ?? tags[0];
    const last = exact ?? tags.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    return quoteArtifactSelection({ id: 'artifact', title: '原稿', content: markdown, sourceStart: Number(first![1]), sourceEnd: Number(last![2]) }).text;
  };
  expect(mapping('8800')).toEndWith('\n8800');
  expect(mapping('甲|乙')).toEndWith('\n甲\\|乙');
  expect(mapping('const budget = 8800;')).toEndWith('\nconst budget = 8800;');
});

test('创建未执行成功不消费确认；成功后模型失败和重试也不重复创建', async () => {
  const store = new WorkbenchStore(root());
  const agents = new WorkbenchAgentStore(store);
  let attempts = 0;
  let creations = 0;
  const service = new WorkbenchService(store, () => [{ id: 'local', name: '本地', contextWindow: 32000 }], async input => {
    if (input.settledTools?.some(call => call.name === 'assistant_create' && call.status === 'complete')) return { text: '助手已经准备好', model: 'local', citations: [] };
    if (input.messages.at(-1)?.text !== '确认创建') return { text: '先核对助手方案', model: 'local', citations: [] };
    attempts += 1;
    if (attempts === 1) throw new Error('模拟创建前模型请求失败');
    const engine = { executeRaw: async () => [{ id: 'default' }] } as never;
    const handlers = agentHandlers({ store: agents, engine, config: () => ({}) as never }, { agent: input.agent!, userText: '确认创建', conversationId: input.conversationId!, messageId: input.messageId!, citations: [], cite: () => 1, active: () => true });
    const output = await handlers.get('assistant_create')!.execute({ name: '报销助手', systemPrompt: '核对发票', workflow: '', sourceIds: ['default'] }, input.signal);
    creations += 1;
    input.onTool?.({ id: 'created', name: 'assistant_create', input: '{}', output: JSON.stringify(output), status: 'complete', startedAt: '' });
    throw new Error('模拟创建成功后模型请求失败');
  });
  const conversation = service.create({ knowledge: false });
  service.send(conversation.id, { text: '创建一个报销助手，负责核对发票' });
  await service.settled(conversation.id);
  const fingerprint = service.get(conversation.id).pending!.fingerprint;
  service.send(conversation.id, { text: '确认创建' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('error');
  expect(service.get(conversation.id).usedConfirm).toBeUndefined();
  expect(service.get(conversation.id).pending?.fingerprint).toBe(fingerprint);
  service.send(conversation.id, { text: '确认创建' });
  await service.settled(conversation.id);
  expect(creations).toBe(1);
  expect(service.get(conversation.id).usedConfirm).toBe(fingerprint);
  expect(service.get(conversation.id).pending).toBeUndefined();
  service.send(conversation.id, { retry: true });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.status).toBe('complete');
  expect(creations).toBe(1);
  service.send(conversation.id, { text: '确认创建' });
  await service.settled(conversation.id);
  expect(service.get(conversation.id).messages.at(-1)?.text).toContain('已经用过');
  expect(creations).toBe(1);
});
