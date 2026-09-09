## PMBrain 1.1.86

- WorkBuddy 用户级长期记忆规则与 Skills 改写到 `~/.workbuddy/`，不再依赖 CodeBuddy 目录。
- Codex 深度接入增加 SessionEnd 漏记兜底、Hook 信任记录与配置自检，保留实时 remember 主路径。
- Claude Code 深度接入继续使用 MCP 实时写回与 Stop Hook 兜底，并纳入统一完整性检查。
- 新增 Grok Build 原生 MCP 一键接入与连接自检，按 Grok 的 `headers` 配置格式写入。

## PMBrain 1.1.85

- WorkBuddy 普通会话现在会收到长期记忆规则与 Skills，明确使用 remember，不再误写客户端 MEMORY.md。
- Codex 与 WorkBuddy 的本地接入会验证现有 Bearer，凭证失效时明确提示并提供一键修复。
- 长期记忆开启时，MCP 初始化合同开头即声明准确写入工具；不会增加不存在的 facts_add 别名。

## PMBrain 1.1.84

- 启动失败和软件修复可在副本上诊断大字段损坏，确认后才替换当前库并留底。
- 系统设置里长期记忆选项点选后不再被刷新打回关闭。
- 修复 PGLite toast 孤儿分块导致无法启动；知识页、Wiki 和 Facts 保留。

## PMBrain 1.1.79

- 新增长期记忆开关，默认关闭，可选择重要内容或全部事实；首次接入询问一次，临时记忆支持到期隐藏。
- 增加 Codex / Claude Code 深度接入与可撤销托管指令；Claude Stop Hook 先暂存、由本地服务抽取，按真实 Source 归属。
- 修复关闭收敛、只读接入合同和 Windows 托管标记兼容；保留已有资料与向量。

## PMBrain 1.1.78

- 兼容吸纳 GBrain 检索与 Dream 修复，保留中文、多 Source 和本地模型行为。

