/**
 * 产品经理可读的测试说明：
 *
 * WorkBuddy 卡片不再做工作目录深度接入。配置好 MCP 后，
 * 「更新」旁边有一个「写入规则与 Agent」。点它往用户级目录写
 * PMBrain 普通会话规则、长期记忆技能、子代理和斜杠命令，不改知识库。
 *
 * 这组测试确认：
 * 1. 会写入用户目录里的 rules、skills、agents 和 commands。
 * 2. 普通 WorkBuddy 会话使用的规则和 Skill 必须写进 ~/.workbuddy，
 *    不能误写到 CodeBuddy 的 ~/.codebuddy 目录。
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
  test('writes global memory rules, skills, agent and slash command into user folders', async () => {
    const homeDir = tempHome();
    const result = await writeWorkbuddyUserAgent({ homeDir });
    expect(result.written).toHaveLength(10);
    expect(result.backedUp).toEqual([]);

    const agent = readFileSync(join(homeDir, '.workbuddy', 'agents', 'pmbrain.md'), 'utf8');
    const command = readFileSync(join(homeDir, '.workbuddy', 'commands', 'pmbrain.md'), 'utf8');
    const codebuddyAgent = readFileSync(join(homeDir, '.codebuddy', 'agents', 'pmbrain.md'), 'utf8');
    const codebuddyCommand = readFileSync(join(homeDir, '.codebuddy', 'commands', 'pmbrain.md'), 'utf8');
    const rule = readFileSync(join(homeDir, '.workbuddy', 'rules', 'pmbrain.md'), 'utf8');
    const rememberSkill = readFileSync(join(homeDir, '.workbuddy', 'skills', 'remember', 'SKILL.md'), 'utf8');
    const durableSkill = readFileSync(join(homeDir, '.workbuddy', 'skills', 'durable-writeback', 'SKILL.md'), 'utf8');

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
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('Official PMBrain Agent Pack v2 for WorkBuddy user scope.');
    expect(rule).toContain('本文件用于 WorkBuddy 普通会话的用户级规则');
    expect(rule).not.toContain('不要把本文件当成用户全局规则');
    expect(rule).toContain('remember');
    expect(rule).toContain('facts_add');
    expect(rule).toContain('不要写入 WorkBuddy 内置 memory');
    expect(rememberSkill).toContain('name: remember');
    expect(durableSkill).toContain('name: durable-writeback');
    expect(result.written.filter(path => path.endsWith('SKILL.md'))).toHaveLength(5);
    expect(result.written.some(path => path.includes(join('.codebuddy', 'rules')))).toBe(false);
    expect(result.written.some(path => path.includes(join('.codebuddy', 'skills')))).toBe(false);
  });

  test('rewrites its own managed pack without creating backups', async () => {
    const homeDir = tempHome();
    await writeWorkbuddyUserAgent({ homeDir });
    const result = await writeWorkbuddyUserAgent({ homeDir });
    expect(result.written).toHaveLength(10);
    expect(result.backedUp).toEqual([]);
  });

  test('automatic convergence refuses to overwrite a user-modified managed file', async () => {
    const homeDir = tempHome();
    await writeWorkbuddyUserAgent({ homeDir });
    const path = join(homeDir, '.workbuddy', 'rules', 'pmbrain.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# my change\n`, 'utf8');
    await expect(writeWorkbuddyUserAgent({ homeDir, overwriteExisting: false }))
      .rejects.toThrow('未静默覆盖');
    expect(readFileSync(path, 'utf8')).toContain('# my change');
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
