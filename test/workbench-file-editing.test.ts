import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHandlers, agentTools } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchStore } from '../src/product/workbench/store';
import { visibleAssistantText } from '../src/product/workbench/playbook';
import { fileRequestAction } from '../src/product/workbench/file-receipts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-file-edit-'));
  const work = join(root, 'work'); const read = join(root, 'read'); const library = join(root, 'library');
  for (const path of [work, read, library]) mkdirSync(path);
  const store = new WorkbenchStore(join(root, 'state'));
  const agents = new WorkbenchAgentStore(store);
  const engine = { executeRaw: async (sql: string) => sql.includes('source_path') ? [] : [{ id: 'default', local_path: library }] } as any;
  const context = { store: agents, engine, config: () => ({ engine: 'pglite' as const, desktop: { knowledge_directory: library } }) };
  const agent = agents.create({ name: '文件助手', workspaceDirectory: work, workspaceAccess: 'read-write', readDirectories: [read] });
  const handlers = (text = '按要求修改文件', current = agent, currentContext = context) => agentHandlers(currentContext, { agent: current, userText: text, conversationId: 'test', messageId: 'turn', citations: [], cite: () => 1, active: () => true });
  const run = (name: string, input: unknown, text?: string) => handlers(text).get(name)!.execute(input, new AbortController().signal) as Promise<any>;
  return { root, work, read, library, agents, context, agent, handlers, run };
}

test('指定路径新建、追加和局部编辑返回磁盘哈希，原文、BOM 与换行保留', async () => {
  const f = fixture();
  try {
    const path = join(f.work, 'PMBrain写的内容.md');
    const first = await f.run('local_write', { path, mode: 'create', content: '\uFEFF原有文章\r\n' });
    expect(first.verified).toBe(true); expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    const read = await f.run('local_read', { path }); expect(read.hash).toBe(first.hash);
    const appended = await f.run('local_write', { path, mode: 'append', content: '\r\n新增文章\r\n', baseHash: read.hash });
    expect(readFileSync(path, 'utf8')).toBe('\uFEFF原有文章\r\n\r\n新增文章\r\n');
    expect(appended.backupId).toBeTruthy(); expect(appended.verified).toBe(true);
    const edited = await f.run('local_edit', { path, baseHash: appended.hash, oldText: '新增文章', newText: '修改后的文章' });
    expect(readFileSync(path, 'utf8')).toBe('\uFEFF原有文章\r\n\r\n修改后的文章\r\n');
    expect(edited.verified).toBe(true);
    await expect(f.run('local_write', { path, mode: 'create', content: '覆盖' })).rejects.toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('过期哈希、重复匹配、二进制文本写入和越权路径都保留原文件', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '稿.md'); writeFileSync(path, '重复\n重复\n');
    const read = await f.run('local_read', { path });
    await expect(f.run('local_edit', { path, baseHash: read.hash, oldText: '重复', newText: '错误' })).rejects.toThrow('多处');
    writeFileSync(path, '用户修改');
    await expect(f.run('local_write', { path, mode: 'append', baseHash: read.hash, content: '不能追加' })).rejects.toThrow('改变');
    expect(readFileSync(path, 'utf8')).toBe('用户修改');
    const other = join(f.read, '原始资料.md'); writeFileSync(other, '原始内容');
    const original = await f.run('local_read', { path: other });
    await expect(f.run('local_delete', { path: other, baseHash: original.hash })).rejects.toThrow();
    await expect(f.run('local_write', { path: join(f.work, '..', '越界.md'), mode: 'create', content: '禁止' })).rejects.toThrow();
    await expect(f.run('local_write', { path: join(f.work, 'binary.docx'), mode: 'create', content: '假 Word' })).rejects.toThrow();
    await expect(f.run('local_write', { path: join(f.work, '稿.md:stream'), mode: 'create', content: 'ADS' })).rejects.toThrow();
    expect(readFileSync(other, 'utf8')).toBe('原始内容');
    symlinkSync(f.read, join(f.work, '链接'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.run('local_write', { path: join(f.work, '链接', '越权.md'), mode: 'create', content: '禁止' })).rejects.toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('删除真实移除文件并留下恢复回执，重启后恢复且不覆盖同名文件', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '写错的稿.md'); writeFileSync(path, '旧稿');
    const read = await f.run('local_stat', { path });
    const deleted = await f.run('local_delete', { path, baseHash: read.hash });
    expect(deleted.deleted).toBe(true); expect(deleted.verified).toBe(true); expect(existsSync(path)).toBe(false);
    const agents = new WorkbenchAgentStore(new WorkbenchStore(join(f.root, 'state')));
    const again = f.handlers('恢复刚才删除的文件', agents.get(f.agent.id), { ...f.context, store: agents });
    const restored = await again.get('local_restore')!.execute({ backupId: deleted.backupId }, new AbortController().signal) as any;
    expect(restored.restored).toBe(true); expect(readFileSync(path, 'utf8')).toBe('旧稿');
    writeFileSync(path, '用户新稿');
    await expect(again.get('local_restore')!.execute({ backupId: deleted.backupId }, new AbortController().signal)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('用户新稿');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('工作目录内可移动和改名已有文件，只读目录和知识库受到保护', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '稿.md'); const folder = join(f.work, '归档'); mkdirSync(folder); writeFileSync(path, '正文');
    const read = await f.run('local_stat', { path });
    const moved = await f.run('local_move', { path, destination: join(folder, '归档稿.md'), baseHash: read.hash });
    expect(existsSync(path)).toBe(false); expect(readFileSync(moved.path, 'utf8')).toBe('正文');
    const renamed = await f.run('local_rename', { path: moved.path, name: '最终稿.md', baseHash: moved.hash });
    expect(readFileSync(renamed.path, 'utf8')).toBe('正文');
    const protectedAgent = f.agents.update(f.agent.id, { ...f.agent, workspaceDirectory: f.library, revision: f.agent.revision });
    const protectedPath = join(f.library, '原资料.md'); writeFileSync(protectedPath, '知识资料');
    await expect(f.handlers('修改文件', protectedAgent).get('local_write')!.execute({ path: protectedPath, mode: 'overwrite', content: '禁止', baseHash: read.hash }, new AbortController().signal)).rejects.toThrow('知识');
    expect(readFileSync(protectedPath, 'utf8')).toBe('知识资料');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('旧助手保留仅新建权限，授权读写后持久化；模型不能自行提升权限', async () => {
  const f = fixture();
  try {
    const legacy = f.agents.create({ name: '旧助手', workspaceDirectory: f.work });
    expect(legacy.workspaceAccess ?? 'new-files').toBe('new-files');
    const path = join(f.work, '原有.md'); writeFileSync(path, '保留');
    await expect(f.handlers('追加内容', legacy).get('local_write')!.execute({ path, mode: 'append', content: '禁止', baseHash: '0'.repeat(64) }, new AbortController().signal)).rejects.toThrow('读写');
    expect(agentTools(f.agent, '文件里写了什么？', f.context).map(row => row.name)).not.toContain('local_delete');
    expect(fileRequestAction('怎样删除文件？')).toBeUndefined();
    expect(fileRequestAction('能帮我删除这个文件吗？')).toBe('delete');
    expect(agentTools(f.agent, '把旧文件删掉', f.context).map(row => row.name)).toContain('local_delete');
    const stored = new WorkbenchAgentStore(new WorkbenchStore(join(f.root, 'state'))).get(f.agent.id);
    expect(stored.workspaceAccess).toBe('read-write');
    expect(readFileSync(path, 'utf8')).toBe('保留');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('追加和删除的成功声明必须有对应工具和路径，独立保存或读取回执不能代替', () => {
  const path = 'D:\\work\\稿.md';
  const claim = `文章已经追加到 ${path} 末尾了。`;
  const receipt = (name: string, data: object) => [{ name, status: 'complete' as const, output: JSON.stringify(data) }];
  expect(visibleAssistantText(claim)).not.toBe(claim);
  expect(visibleAssistantText(claim, receipt('artifact_save', { saved: true, path }))).not.toBe(claim);
  expect(visibleAssistantText(claim, receipt('local_read', { path, content: '正文' }))).not.toBe(claim);
  expect(visibleAssistantText(claim, receipt('local_write', { path, mode: 'append', written: true, verified: true, hash: 'a'.repeat(64) }))).toBe(claim);
  expect(visibleAssistantText(claim, receipt('local_write', { path: 'D:\\work\\另稿.md', mode: 'append', written: true, verified: true }))).not.toBe(claim);
  expect(visibleAssistantText('旧文件已经删除。')).toContain('没有');
  expect(visibleAssistantText(`已通过文件工具完成替换，回执 verified=true。文件路径：${path}`)).toContain('没有');
});

test('执行器绑定本轮读取哈希，模型可使用相对路径；缺少读取或外部修改仍拒绝写入', async () => {
  const f = fixture();
  try {
    const path = join(f.work, '稿.md'); writeFileSync(path, '原文');
    const tools = f.handlers(); const execute = (name: string, input: object) => tools.get(name)!.execute(input, new AbortController().signal) as Promise<any>;
    await expect(execute('local_write', { path: '稿.md', mode: 'append', content: '禁止' })).rejects.toThrow('哈希');
    await execute('local_read', { path: '稿.md' });
    const written = await execute('local_write', { path: '稿.md', mode: 'append', content: '追加' });
    expect(written.verified).toBe(true); expect(readFileSync(path, 'utf8')).toBe('原文追加');
    await execute('local_read', { path: '稿.md' }); writeFileSync(path, '人工改稿');
    await expect(execute('local_delete', { path: '稿.md' })).rejects.toThrow('改变');
    expect(readFileSync(path, 'utf8')).toBe('人工改稿');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('复制后再改名可沿真实路径回执核对，原始文件和无关目标不能混为一份', () => {
  const source = 'D:\\work\\笔记.md'; const copied = 'D:\\work\\归档\\笔记.md'; const renamed = 'D:\\work\\归档\\归档稿.md';
  const calls = [{ name: 'local_copy', status: 'complete', output: JSON.stringify({ source, path: copied, copied: true }) }, { name: 'local_rename', status: 'complete', output: JSON.stringify({ from: copied, path: renamed, renamed: true }) }];
  const claim = `已将笔记.md复制进去并重命名为归档稿.md：\`${renamed}\``;
  expect(visibleAssistantText(claim, calls)).toBe(claim);
  expect(visibleAssistantText(`已复制到 \`D:\\work\\无关.md\``, calls)).toContain('没有');
});
