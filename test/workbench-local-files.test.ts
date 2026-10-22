import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHandlers, agentTools } from '../src/product/workbench/agent-tools';
import { WorkbenchAgentStore } from '../src/product/workbench/agents';
import { WorkbenchStore } from '../src/product/workbench/store';
import { advanceTask } from '../src/product/workbench/task-context';
import type { WorkbenchTask } from '../shared/workbench';

test('授权目录可以新建文件夹并复制文件，原始资料不能被改名、覆盖或删除，重启后仍能改已复制的文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-local-files-'));
  try {
    const output = join(root, 'output');
    const readRoot = join(root, 'read');
    const child = join(readRoot, '整理');
    mkdirSync(output); mkdirSync(readRoot); mkdirSync(child);
    writeFileSync(join(readRoot, '原文.md'), '原始内容');
    const store = new WorkbenchStore(join(root, 'workbench'));
    const agents = new WorkbenchAgentStore(store);
    const engine = { executeRaw: async (sql: string) => sql.includes('local_path') ? [{ id: 'default', local_path: output }] : [{ id: 'default' }] } as any;
    const agent = agents.create({ name: '项目助手', readDirectories: [readRoot] });
    const handlers = agentHandlers({ store: agents, engine, config: () => ({ engine: 'pglite' }) }, { agent, userText: '整理这些资料', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true });
    const names = agentTools(agent, '整理这些资料', { store: agents, engine, config: () => ({ engine: 'pglite' }) }).map(tool => tool.name);
    expect(names).toContain('local_copy');
    expect(names).toContain('local_rename');
    expect(agentTools(agent, '先创建文件夹', { store: agents, engine, config: () => ({ engine: 'pglite' }) }).map(tool => tool.name)).toEqual(['local_mkdir']);
    const folder = await handlers.get('local_mkdir')!.execute({ directory: readRoot, name: '本周' }, new AbortController().signal) as { path: string };
    expect(folder.path).toBe(join(readRoot, '本周'));
    const outside = join(root, 'outside');
    await expect(handlers.get('local_mkdir')!.execute({ directory: outside, name: '越权' }, new AbortController().signal)).rejects.toThrow();
    const copied = await handlers.get('local_copy')!.execute({ source: join(readRoot, '原文.md'), directory: output }, new AbortController().signal) as { path: string };
    expect(readFileSync(copied.path, 'utf8')).toBe('原始内容');
    expect(readFileSync(join(readRoot, '原文.md'), 'utf8')).toBe('原始内容');
    const nested = await handlers.get('local_copy')!.execute({ source: join(readRoot, '原文.md'), directory: child }, new AbortController().signal) as { path: string };
    expect(readFileSync(nested.path, 'utf8')).toBe('原始内容');
    await expect(handlers.get('local_copy')!.execute({ source: join(readRoot, '原文.md'), directory: readRoot }, new AbortController().signal)).rejects.toThrow();
    await expect(handlers.get('local_copy')!.execute({ source: join(readRoot, '原文.md'), directory: output }, new AbortController().signal)).rejects.toThrow();
    await expect(handlers.get('local_rename')!.execute({ path: join(readRoot, '原文.md'), name: '改名.md' }, new AbortController().signal)).rejects.toThrow();
    expect(readFileSync(join(readRoot, '原文.md'), 'utf8')).toBe('原始内容');
    const task: WorkbenchTask = { id: 'task', goal: '整理', constraints: [], updatedAt: '', managedPaths: [copied.path] };
    const renamed = await agentHandlers({ store: agents, engine, config: () => ({ engine: 'pglite' }) }, { agent, userText: '整理这些资料', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true, managedPaths: () => task.managedPaths ?? [], rememberManaged: (path, from) => { task.managedPaths = [...(task.managedPaths ?? []).filter(item => item !== from), path]; } }).get('local_rename')!.execute({ path: copied.path, name: '报告.md' }, new AbortController().signal) as { path: string };
    expect(readFileSync(renamed.path, 'utf8')).toBe('原始内容');
    const continued = advanceTask({ task, text: '另外做一份汇总', recentUserTexts: [], agent: {}, now: '', id: () => 'next' });
    expect(continued.task?.managedPaths).toContain(renamed.path);
    const reloaded = new WorkbenchStore(join(root, 'workbench'));
    const again = await agentHandlers({ store: new WorkbenchAgentStore(reloaded), engine, config: () => ({ engine: 'pglite' }) }, { agent, userText: '继续改', conversationId: 'unused', messageId: 'unused', citations: [], cite: () => 1, active: () => true, managedPaths: () => continued.task?.managedPaths ?? [] }).get('local_rename')!.execute({ path: renamed.path, name: '报告-修订.md' }, new AbortController().signal) as { path: string };
    expect(readFileSync(again.path, 'utf8')).toBe('原始内容');
    expect(readFileSync(join(readRoot, '原文.md'), 'utf8')).toBe('原始内容');
    const link = join(output, '链接.md');
    try { symlinkSync(join(readRoot, '原文.md'), link, 'file'); }
    catch (error) { if (!String(error).includes('EPERM')) throw error; }
    if (existsSync(link)) await expect(handlers.get('local_copy')!.execute({ source: link, directory: child }, new AbortController().signal)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
