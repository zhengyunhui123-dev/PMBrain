/**
 * 产品经理可读的测试说明：
 *
 * WorkBuddy 卡片不再做工作目录深度接入。配置好 MCP 后，
 * 「更新」旁边有一个「Agent写入」。点它只往用户级目录写
 * PMBrain 子代理和斜杠命令，不改知识库。
 *
 * 这组测试确认：
 * 1. 会写入用户目录里的 agents/pmbrain.md 和 commands/pmbrain.md。
 * 2. 同时写到 WorkBuddy 自己的用户目录，以及它实际读取的
 *    ~/.codebuddy 用户目录，这样 @pmbrain 和 /pmbrain 能用。
 * 3. 子代理声明使用已经接入的 pmbrain MCP，不另起一套工具。
 * 4. 用户自己改过的同名文件会先备份，再覆盖。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  USER_AGENT_MARKER,
  writeWorkbuddyUserAgent,
} from '../src/main/integration/user-agent-writer.js';

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-user-agent-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkBuddy user-level agent write', () => {
  test('writes pmbrain agent and slash command into user folders', async () => {
    const homeDir = tempHome();
    const result = await writeWorkbuddyUserAgent({ homeDir });
    expect(result.written).toHaveLength(4);
    expect(result.backedUp).toEqual([]);

    const agent = readFileSync(join(homeDir, '.workbuddy', 'agents', 'pmbrain.md'), 'utf8');
    const command = readFileSync(join(homeDir, '.workbuddy', 'commands', 'pmbrain.md'), 'utf8');
    const codebuddyAgent = readFileSync(join(homeDir, '.codebuddy', 'agents', 'pmbrain.md'), 'utf8');
    const codebuddyCommand = readFileSync(join(homeDir, '.codebuddy', 'commands', 'pmbrain.md'), 'utf8');

    expect(agent).toContain(USER_AGENT_MARKER);
    expect(agent).toContain('name: pmbrain');
    expect(agent).toContain('mcpServers:');
    expect(agent).toContain('- pmbrain');
    expect(agent).toContain('@pmbrain');
    expect(agent).toContain('list_skills');
    expect(agent).toContain('get_skill');
    expect(command).toContain('/pmbrain');
    expect(command).toContain('list_skills');
    expect(command).toContain('$ARGUMENTS');
    expect(codebuddyAgent).toContain('name: pmbrain');
    expect(codebuddyCommand).toContain('/pmbrain');
  });

  test('backs up a user-modified file before replacing it', async () => {
    const homeDir = tempHome();
    const path = join(homeDir, '.workbuddy', 'agents');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'pmbrain.md'), '# my own agent\n', 'utf8');

    const result = await writeWorkbuddyUserAgent({ homeDir });
    expect(result.backedUp.some(item => item.endsWith(join('agents', 'pmbrain.md')))).toBe(true);
    expect(readFileSync(join(path, 'pmbrain.md'), 'utf8')).toContain('name: pmbrain');
    expect(readFileSync(join(path, 'pmbrain.md.pmbrain-bak'), 'utf8')).toContain('# my own agent');
  });
});
