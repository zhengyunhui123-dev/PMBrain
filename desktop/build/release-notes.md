## PMBrain 1.1.96

- MCP 接入新增 Qwen Code、Qoder CN（通义灵码）、ZCode（智谱）、MiMo Code（小米）和 Kimi Code（月之暗面），按各客户端配置格式安全合并，不覆盖已有设置。
- 接入列表默认保持既定顺序；已接入客户端自动排到前面，已接入和未接入两组内部仍按默认顺序排列。
- 修复 Windows PGLite 一次性命令成功完成后进程不退出，导致桌面首次初始化和打包运行时导入超时的问题。

## PMBrain 1.1.95

- Codex、Grok 会话文件夹可直接识别 JSONL；大会话改为流式上传和逐行解析，不再受 20 MB 或 50 MB 会话限制。
- Source 同步不再被固定 10 分钟中断；缺失链接改为中文提示，并提供只读明细入口。
- 修复首次隔离配置提前启动 Sidecar 造成的 PGLite 自占用，以及新增知识分类测试的 CI 隔离错误。

## PMBrain 1.1.94

- 知识库“原始与资料”更名为“原始资料”，导入、同步的笔记不再仅因内容类型而进入结构化知识。
- 结构化知识按现有生成标记识别二次加工成果；事实、观点与总结保持原有分类，不修改历史知识数据。
- 修正发布说明版本、迁移测试隔离目录与桌面首次自动初始化的 CI 验证。

## PMBrain 1.1.93

- 自定义模型连接测试支持等待本地或远程模型冷启动，等待上限调整为 120 秒。
- 事实按显示的更新时间排序，知识列表同时间记录顺序稳定，任务完成后按最近时间上移。

## PMBrain 1.1.92

- MCP 接入新增 CherryStudio 并置于首位，CodeBuddy 调整到最后；CherryStudio 提供可复制导入的 Streamable HTTP 配置，不直接修改它的 SQLite 数据库。
- 桌面端首次运行会立即创建独立的 `~/.pmbrain/config.json` 与 PGLite `brain.pglite`，不再自动发现、读取或复用已有 `~/.gbrain`。
- 安装版 Sidecar 会隔离继承到的 GBrain Home、数据库、Source、Brain 与 Mount 路由变量，旧 `.gbrain-source`、`.gbrain-mount` 也不会影响 PMBrain。
