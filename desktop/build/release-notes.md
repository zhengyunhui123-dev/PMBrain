## PMBrain 1.1.92

- MCP 接入新增 CherryStudio 并置于首位，CodeBuddy 调整到最后；CherryStudio 提供可复制导入的 Streamable HTTP 配置，不直接修改它的 SQLite 数据库。
- 桌面端首次运行会立即创建独立的 `~/.pmbrain/config.json` 与 PGLite `brain.pglite`，不再自动发现、读取或复用已有 `~/.gbrain`。
- 安装版 Sidecar 会隔离继承到的 GBrain Home、数据库、Source、Brain 与 Mount 路由变量，旧 `.gbrain-source`、`.gbrain-mount` 也不会影响 PMBrain。

## PMBrain 1.1.91

- MCP 接入页会在 Sidecar 真正就绪后重新验证，不再把启动前的空探测当作完成。
- 最近一次验证可用的状态会保存在不含凭证的本地回执中，打开页面立即沿用，后台再静默复核；旧配置快照不再把它清空。
- CodeBuddy、Cursor、Trae 也会校验现存 Bearer；401/403 显示“接入失效”，临时超时显示“待验证”。

## PMBrain 1.1.90

- 修复 Ubuntu CI 中安装包 Sidecar 回归测试写死 Windows 路径导致的跨平台误报。
- 修正 Home 迁移测试：未设置覆盖变量时，若已有 `~/.gbrain`，应按兼容合同继续复用，而不是无条件断言 `~/.pmbrain`。

## PMBrain 1.1.89

- 修复 Windows 安装包在系统未安装 Bun 时，知识导入、搜索和维护子任务无法启动的问题；后台任务改为复用安装包内置 Bun 运行时。
- 发布标签必须在包含对应 Desktop 版本的提交上创建；`v1.1.88` 标签误指向 1.1.87 源码的发布门禁错误不再作为程序故障处理。

## PMBrain 1.1.88

- “更新连接”和“深度接入”现在会立即打开当前客户端的进度弹窗，分别说明凭证验证、配置写入、自动记忆规则与重启要求。
- 已通过直接验证并写入的配置立即显示“凭证可用”，全客户端后台复核不再让按钮长时间停在“正在验证”。
- 失效状态改为“重新生成凭证”，移除容易与卡片状态冲突的全局成功横幅；长期记忆范围仍在“系统设置”统一修改。
