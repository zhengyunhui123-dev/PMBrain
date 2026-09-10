## PMBrain 1.1.88

- “更新连接”和“深度接入”现在会立即打开当前客户端的进度弹窗，分别说明凭证验证、配置写入、自动记忆规则与重启要求。
- 已通过直接验证并写入的配置立即显示“凭证可用”，全客户端后台复核不再让按钮长时间停在“正在验证”。
- 失效状态改为“重新生成凭证”，移除容易与卡片状态冲突的全局成功横幅；长期记忆范围仍在“系统设置”统一修改。

## PMBrain 1.1.87

- MCP 接入页先显示本地配置卡片，再在后台并行刷新连接状态，不再因探测等待出现空白页。
- Codex、Claude Code、Grok Build 统一显示“深度接入”；Grok 深度接入复用其实际可读取的 Claude 兼容记忆合同。
- 长期记忆首次选择不再被异步状态刷新覆盖；尚无已验证 MCP 连接时明确引导用户先完成 MCP 接入。

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
