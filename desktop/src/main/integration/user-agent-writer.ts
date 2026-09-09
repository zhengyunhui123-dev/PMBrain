import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WORKBUDDY_AGENT_INTEGRATION } from './agent-integration/index.js';

export const USER_AGENT_MARKER = '<!-- pmbrain-managed:user-agent:1 -->';
export const USER_PACK_MARKER = '<!-- pmbrain-managed:user-pack:2 -->';
const AGENT_FILE = 'pmbrain.md';

export function workbuddyUserAgentFiles(homeDir = homedir()): string[] {
  return [
    join(homeDir, '.workbuddy', 'agents', AGENT_FILE),
    join(homeDir, '.workbuddy', 'commands', AGENT_FILE),
    join(homeDir, '.codebuddy', 'agents', AGENT_FILE),
    join(homeDir, '.codebuddy', 'commands', AGENT_FILE),
  ];
}

function agentMarkdown(): string {
  return `${USER_AGENT_MARKER}
---
name: pmbrain
description: PMBrain 知识子代理。用户说 @pmbrain、/pmbrain，或要检索、记住、整理知识时使用。通过已接入的 PMBrain MCP 路由全部知识工具，不要编造知识库内容。
mcpServers:
  - pmbrain
---

你是 PMBrain 知识子代理。用户可以用 @pmbrain 或 /pmbrain 叫你。

只通过已经接入的 MCP 服务器 \`pmbrain\` 工作。这个服务器上有检索、记忆、页面、整理等 80+ 工具，还有 list_skills / get_skill。

怎么干活：
1. 用户要写方案、汇报稿、公文、报告、教程，或按某种文风写时，先调用 list_skills，按 triggers 选中技能，再 get_skill 读完整说明并按它执行。
2. 项目事实、人物、进展用 search / query / think。不要只用搜索代替 Skill。
3. 先 Skill 后检索：Skill 管写法，检索管材料。

规则：
- 知识读写只走 PMBrain MCP，不要写到客户端自己的 memory 或其他本地备忘。
- 用户说“记住/忘掉”时，用 remember / forget，不要另存一份；PMBrain 不存在 facts_add，不要猜测别名。
- 一次没搜到，换关键词或指定 Source 再查，不要直接说资料不存在。
- 不要删除、覆盖 Wiki 或原始资料。
- 做完用中文简短汇报：用了哪个 Skill、查了什么、写了什么、还缺什么。
`;
}

function commandMarkdown(): string {
  return `${USER_AGENT_MARKER}
---
description: "调用 /pmbrain：通过已接入的 PMBrain MCP 使用知识工具。"
argument-hint: "[问题或任务]"
---

使用 pmbrain 子代理处理：$ARGUMENTS

先 list_skills / get_skill 看有没有方案、汇报、公文或文风 Skill，再 search/query/think 取项目材料。不要只搜知识正文、跳过 Skill。不要编造知识库内容，也不要写到客户端内置 memory。
`;
}

function markPackContent(content: string): string {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontmatter) return `${USER_PACK_MARKER}\n${content}`;
  return `${frontmatter[0]}${USER_PACK_MARKER}\n${content.slice(frontmatter[0].length)}`;
}

function globalRuleContent(): string {
  return WORKBUDDY_AGENT_INTEGRATION.instruction.content
    .replace('for WorkBuddy workspace scope.', 'for WorkBuddy user scope.')
    .replace('不要把本文件当成用户全局规则。', '本文件用于 WorkBuddy 普通会话的用户级规则。')
    .replace('WorkBuddy workspace 的 PMBrain Skills', 'WorkBuddy 用户级 PMBrain Skills');
}

function workbuddyUserPackFiles(homeDir = homedir()): Array<{ path: string; content: string; marker: string }> {
  return [
    {
      path: join(homeDir, WORKBUDDY_AGENT_INTEGRATION.instruction.relativePath),
      content: markPackContent(globalRuleContent()),
      marker: USER_PACK_MARKER,
    },
    ...WORKBUDDY_AGENT_INTEGRATION.skills.map(skill => ({
      path: join(homeDir, skill.relativePath),
      content: markPackContent(skill.content),
      marker: USER_PACK_MARKER,
    })),
  ];
}

async function writeManagedFile(
  path: string,
  content: string,
  marker = USER_AGENT_MARKER,
  overwriteExisting = true,
): Promise<'written' | 'backed-up'> {
  await mkdir(dirname(path), { recursive: true });
  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing != null && existing !== content && !overwriteExisting) {
    throw new Error(`检测到已有或已修改的 WorkBuddy 文件，未静默覆盖：${path}。请在 MCP 接入中点击“写入规则与 Agent”确认更新。`);
  }
  if (existing != null && !existing.includes(marker)) {
    await copyFile(path, `${path}.pmbrain-bak`);
    await writeFile(path, content, 'utf8');
    return 'backed-up';
  }
  await writeFile(path, content, 'utf8');
  return 'written';
}

export async function writeWorkbuddyUserAgent(options: { homeDir?: string; overwriteExisting?: boolean } = {}): Promise<{
  written: string[];
  backedUp: string[];
}> {
  const agentFiles = workbuddyUserAgentFiles(options.homeDir).map(path => {
    const kind = /[\\/]commands[\\/]pmbrain\.md$/i.test(path) ? 'command' : 'agent';
    return { path, content: kind === 'command' ? commandMarkdown() : agentMarkdown(), marker: USER_AGENT_MARKER };
  });
  const files = [...agentFiles, ...workbuddyUserPackFiles(options.homeDir)];
  const written: string[] = [];
  const backedUp: string[] = [];
  for (const file of files) {
    const result = await writeManagedFile(file.path, file.content, file.marker, options.overwriteExisting ?? true);
    written.push(file.path);
    if (result === 'backed-up') backedUp.push(file.path);
  }
  return { written, backedUp };
}
