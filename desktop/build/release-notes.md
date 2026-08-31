## PMBrain 1.1.50

- 修复从 Desktop 1.1.49 升级后数据库显示 schema 119、实际缺少 Dream 私有队列列而导致 Sidecar 启动失败的问题。
- 升级会先幂等补齐当前 schema 所需列，再迁移到 schema 122 并补全外键和索引；不会清空、覆盖或重建用户数据库。

## PMBrain 1.1.49

- 总体概览增加知识库健康卡片，显示 Advisor 评分和最重要建议；可复用现有补向量、同步和孤立页整理任务。
- Advisor 增加版本缓存、迁移、任务、同步、向量与配置检查，并保留只读默认和修复白名单。

## PMBrain 1.1.48

- 升级后首次打开不再在 45 秒健康检查时杀掉仍在迁移的 Sidecar。PGLite 升级最长等待 10 分钟，让大库的兼容迁移和索引建完。
- Sidecar 启动失败时，桌面日志必须写下 pid、exit code 和完整 stderr；没有输出也会明确记成 empty。

## PMBrain 1.1.47

- GitHub 安装包下载页和软件更新说明只保留最近 5 次更新，不再堆积完整历史。

## PMBrain 1.1.46

- MCP 接入将 Trae 改为 Trae Work，写入 `%APPDATA%\TRAE SOLO CN\User\mcp.json`，不再写入已停用的 `Trae\User\mcp.json`。
