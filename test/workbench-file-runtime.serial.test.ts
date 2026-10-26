import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, __setChatTransportForTests, chat, toolLoop, type ChatResult } from '../src/core/ai/gateway';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';
import { knowledgeWorkbenchAnswer } from '../src/product/workbench/routes';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
const answer = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], model: 'service-files:chat', providerId: 'service-files', usage, stopReason: 'end' });
const call = (name: string, input: unknown): ChatResult => ({ ...answer(''), blocks: [{ type: 'tool-call', toolName: name, input, toolCallId: name }], stopReason: 'tool_calls' });
function setTransport(transport: Parameters<typeof __setChatTransportForTests>[0]) {
  __setChatTransportForTests(transport && (async options => {
    const result = await transport(options);
    if (options.responseSchema?.name !== 'entity_response') return result;
    const calls = result.blocks.filter((block): block is Extract<typeof block, { type: 'tool-call' }> => block.type === 'tool-call');
    return answer(JSON.stringify(calls.length ? { tool_calls: calls.map(block => ({ name: block.toolName, arguments: block.input })) } : { answer: result.text }));
  }));
}
beforeEach(() => configureGateway({ generative_enabled: true, chat_model: 'service-files:chat', env: {} }));
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-file-runtime-')); const work = join(root, 'work'); mkdirSync(work);
  const store = new WorkbenchStore(join(root, 'state')); const agents = new WorkbenchAgentStore(store);
  const engine = { executeRaw: async () => [], getConfig: async () => null, getPage: async () => null } as any;
  const context = { store: agents, engine, config: () => ({ engine: 'pglite' as const }) };
  const open = () => new WorkbenchService(store, () => [{ id: 'service-files:chat', name: '测试模型', contextWindow: 65536 }], knowledgeWorkbenchAnswer(engine, { search: async () => ({ results: [] } as any), answer: chat, loop: toolLoop }, undefined, context));
  const agent = agents.create({ name: '写作助手', workspaceDirectory: work, workspaceAccess: 'read-write', deliveryFormat: 'markdown' });
  return { root, work, store, agents, context, open, agent };
}
function toolOutput(options: any, name: string) {
  for (const message of [...options.messages].reverse()) {
    let content = message.content;
    if (typeof content === 'string') { try { content = JSON.parse(content); } catch { continue; } }
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block.type === 'tool-result' && (block.toolName === name || block.toolCallId === name || String(block.toolCallId).startsWith('json-'))) {
      const data = typeof block.output === 'string' ? JSON.parse(block.output) : block.output;
      if (data?.hash) return data;
    }
  }
  return undefined;
}

test('模型先空报追加时必须纠正并实际写入，跨轮重载后可删除和恢复', async () => {
  const f = fixture();
  try {
    const path = join(f.work, 'PMBrain写的内容.md'); writeFileSync(path, '原文章\n');
    let service = f.open(); const conversation = service.create({ assistantId: f.agent.id, knowledge: false });
    let count = 0;
    setTransport(async options => {
      count++;
      if (count === 1) return answer(`文章已经追加到 ${path} 末尾了。`);
      if (count === 2) { expect(options.toolChoice).toBe('required'); expect(JSON.stringify(options.messages.at(-1))).toContain('不能声称'); return call('local_read', { path }); }
      if (count === 3) { expect(options.toolChoice).toBe('required'); const seen = toolOutput(options, 'local_read'); expect(seen.hash).toBeTruthy(); return call('local_write', { path, mode: 'append', content: '\n新文章\n', baseHash: seen.hash }); }
      expect(options.toolChoice).toBeUndefined();
      return answer(`文章已经追加到 ${path} 末尾了。`);
    });
    service.send(conversation.id, { text: `把新文章追加到 ${path} 末尾` }); await service.settled(conversation.id);
    const reply = service.get(conversation.id).messages.at(-1)!;
    expect(reply.error).toBeUndefined(); expect(reply.status).toBe('complete');
    expect(reply.toolCalls?.some(row => row.name === 'local_write' && row.status === 'complete')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('原文章\n\n新文章\n'); expect(f.agents.artifacts()).toHaveLength(0);
    service = f.open(); count = 0;
    setTransport(async options => {
      if (++count === 1) return call('local_stat', { path });
      if (count === 2) return call('local_delete', { path, baseHash: toolOutput(options, 'local_stat').hash });
      return answer(`文件已经删除：${path}`);
    });
    service.send(conversation.id, { text: '之前那份文件删掉' }); await service.settled(conversation.id);
    const deleted = service.get(conversation.id).messages.at(-1)!;
    expect(deleted.error).toBeUndefined(); expect(existsSync(path)).toBe(false);
    const backupId = JSON.parse(deleted.toolCalls!.find(row => row.name === 'local_delete')!.output!).backupId;
    service = f.open(); count = 0;
    setTransport(async () => ++count === 1 ? call('local_restore', { backupId }) : answer(`文件已经恢复：${path}`));
    service.send(conversation.id, { text: '恢复刚才删除的文件' }); await service.settled(conversation.id);
    expect(service.get(conversation.id).messages.at(-1)!.error).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('原文章\n\n新文章\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('读取或独立保存不能冒充追加成功，重复空报会明确失败', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '空文件.md'); writeFileSync(path, ''); let count = 0;
    setTransport(async () => { count++; return count === 1 ? call('local_read', { path }) : answer(`文章已经追加到 ${path} 末尾了。`); });
    const service = f.open(); const conversation = service.create({ assistantId: f.agent.id, knowledge: false });
    service.send(conversation.id, { text: `向 ${path} 追加文章` }); await service.settled(conversation.id);
    const reply = service.get(conversation.id).messages.at(-1)!;
    expect(reply.status).toBe('error'); expect(reply.error).toContain('成功回执'); expect(reply.text).not.toContain('已经追加');
    expect(readFileSync(path, 'utf8')).toBe(''); expect(count).toBe(3);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('追加后响应中断再重试不会重复追加，文件被外部改过时不复用旧成功回执', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '稿.md'); writeFileSync(path, '原文'); let count = 0; let savedInput: any;
    setTransport(async options => {
      if (++count === 1) return call('local_read', { path });
      if (count === 2) { savedInput = { path, mode: 'append', content: '追加', baseHash: toolOutput(options, 'local_read').hash }; return call('local_write', savedInput); }
      throw new Error('测试响应中断');
    });
    const service = f.open(); const conversation = service.create({ assistantId: f.agent.id, knowledge: false });
    service.send(conversation.id, { text: `向 ${path} 追加内容` }); await service.settled(conversation.id);
    expect(readFileSync(path, 'utf8')).toBe('原文追加');
    count = 0; setTransport(async () => ++count === 1 ? call('local_write', savedInput) : answer(`文件已经追加：${path}`));
    service.send(conversation.id, { retry: true }); await service.settled(conversation.id);
    expect(service.get(conversation.id).messages.at(-1)!.error).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('原文追加');
    writeFileSync(path, '人工新稿'); count = 0;
    service.send(conversation.id, { retry: true }); await service.settled(conversation.id);
    expect(service.get(conversation.id).messages.at(-1)!.status).toBe('error');
    expect(readFileSync(path, 'utf8')).toBe('人工新稿');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('模型未经检查就说文件不存在时，先实际核对再删除', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '旧稿.md'); writeFileSync(path, '旧稿'); let count = 0;
    setTransport(async options => {
      if (++count === 1) return answer('当前目录没有旧稿.md，因此无法删除。');
      if (count === 2) return call('local_stat', { path });
      if (count === 3) return call('local_delete', { path, baseHash: toolOutput(options, 'local_stat').hash });
      return answer(`文件已经删除：${path}`);
    });
    const service = f.open(); const conversation = service.create({ assistantId: f.agent.id, knowledge: false });
    service.send(conversation.id, { text: '把旧稿.md删除' }); await service.settled(conversation.id);
    expect(service.get(conversation.id).messages.at(-1)!.error).toBeUndefined(); expect(existsSync(path)).toBe(false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
