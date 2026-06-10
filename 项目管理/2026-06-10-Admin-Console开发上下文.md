# PMBrain Admin Console 开发上下文（2026-06-10）

## Git 提交

- Commit: b34bf21
- Message: feat: improve admin console workflow
- 仓库路径：`D:\cursor-claude\PMBrain`

## 项目目标

PMBrain 是本地知识库系统。Admin Console 的目标不是传统后台，而是类似 ChatGPT / Claude 的 AI 控制台：用户通过自然语言操作 PMBrain，系统调用已配置 LLM 做意图识别、参数提取和操作规划，再由后端校验并映射到 PMBrain Action 白名单执行。

允许动作包括 `capture_memory`、`search_brain`、`import_path`、`sync_source`、`sync_all`、`embed_stale`、`show_sources`、`show_stats`、`show_config`、`doctor_check`。禁止任意 shell、PowerShell、删除数据库、删除 source、`forget`、migration 等危险操作。

## 本次关键改动

### 1. 自然语言任务框与 MIMO 返回解析

- Admin Console 后端不再假设 LLM 只返回纯 JSON。
- 支持从 `text`、`tool_calls`、`function_call`、structured output、Markdown fenced JSON、普通文本中解析 PMBrain intent。
- 后端仍做白名单校验，再映射到安全 action。
- 修复单个 Markdown 文件导入：例如 `D:\Obsidian\Vault\raw\a.md` 会识别为 `import_path` + `pathType=file`，并走单文件导入逻辑。

### 2. 向量化重复与成本风险

- 检查发现数据库 chunks 使用 `zeroentropyai:zembed-1`，但用户私有配置一度指向 Zhipu embedding，可能造成模型/维度不一致和重复向量化成本。
- 已调整用户私有配置使用 `zeroentropyai:zembed-1`，避免继续消耗智谱额度。

### 3. Admin Token 与登录体验

- 终端 Admin Token 改成单行输出，便于复制。
- 登录页品牌从 GBrain 改成 PMBrain。
- 登录页说明：一次性管理员登录链接是 URL，应该直接在浏览器打开，不是粘贴到输入框；输入框只粘贴终端 Admin Token。
- “请给我 PMBrain 管理员登录链接”提示块改成白底、蓝色边框、深蓝加粗文字，提高可读性。
- 掉线机制说明：Admin session 存在服务进程内存中，服务重启后原 cookie 对新进程失效，会回到登录页。若未设置 `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`，每次启动还会生成新 Admin Token。
- 稳定启动建议设置固定 `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` 并使用 `--suppress-bootstrap-token`。

### 4. Admin Console 信息架构

- 左侧菜单改成分组结构：工作台、知识数据、AI 接入、运维设置。
- Agent 管理从一级菜单移除，合并到 MCP 接入页内部。
- 侧边栏底部增加帮助中心和企微助手。
- 帮助中心有二级菜单：使用文档、常见问题。
- 企微助手展示用户提供的二维码图片 `admin/public/wecom-helper.jpg`。
- 侧边栏改为 `100vh` 固定布局，主内容独立滚动，帮助中心/企微助手/退出所有会话始终保持在一屏内可见。

### 5. MCP 接入页面

- 增加 MCP 接入教程按钮，教程包含 CodeBuddy 配置方式。
- CodeBuddy 配置使用 HTTP MCP：`type=http`，`url=http://localhost:3131/mcp`，`Authorization: Bearer <API Key>`。
- MCP 页面标题旁增加问号说明浮层。
- “Agent 管理”和“凭证管理”合并成一个概念：Agent 凭证管理。
- Agent 凭证管理说明：给 CodeBuddy、Cursor、Claude 等外部 AI 工具创建独立 API Key 或 OAuth 客户端，便于单独撤销、审计请求日志和控制权限。

### 6. 请求日志、任务监控、系统诊断

- 请求日志标题增加问号说明：用于查看外部 Agent 通过 MCP 调用 PMBrain 的时间、操作、参数、延迟和状态。
- 任务监控页补充说明：观察导入、同步、向量化、自然语言执行等后台队列健康。
- 系统诊断页 `doctor --fast` 运行记录可在本次服务运行期间保留，切换页面回来仍可看到最近记录。

### 7. 知识库数据浏览与详情抽屉

- 数据浏览页后端列表接口支持受控 `limit`，只允许每页 10/20/40 条，默认 10 条。
- 前端底部分页改为页码式：共 N 条、10条/页、页码按钮、上一页/下一页、前往页。
- 移除顶部分页和筛选栏里的每页条数控件。
- 详情抽屉不再展示全部字段和大段 frontmatter，而是展示概要、chunk 状态和 chunk 正文。
- 新增 Admin 只读接口：`GET /admin/api/brain/pages/:sourceId/:slug/chunks`，返回当前 page 的 `chunk_index`、`chunk_text`、`chunk_source`、`token_count`、`embedded`。
- 抽屉中的 chunk 方块可点击，默认显示 Chunk 1，点击任意编号会切换下方对应 chunk 正文。

### 8. README 与项目管理

- README 增加 GUI 管理控制台能力。
- 原“搜索可视化 + 可溯源”改为“原始数据和知识库数据可视化”。
- 安装和日常使用增加 `serve --http --port 3131`、Admin Token、固定 bootstrap token 说明。
- `项目管理/变更台账.md` 与 `项目管理/Bug修复台账.md` 已记录本次明确需求和修复。

### 9. 安全与配置

- `.mcp.json` 中真实 Bearer token 替换为 `YOUR_GBRAIN_TOKEN_HERE`。
- `.gitignore` 增加 `.mcp.json`，避免后续提交真实本地 MCP token。

## 验证结果

- `bun run build:admin` 通过。
- `bun test test/serve-http-bootstrap-token.test.ts` 通过，10 个测试全过。
- browser-use 验证过以下页面：
  - 登录页提示块可读性：白底、深蓝字、蓝色边框。
  - 数据浏览页：默认 10 行，只有底部分页，筛选栏不再有每页条数。
  - chunk 详情：点击 Chunk 1 和 Chunk 2 显示不同正文，选中态正常。
  - MCP 页：只出现 Agent 凭证管理，不再重复显示凭证管理/Agent 管理两个标题。
  - 请求日志问号说明、任务监控说明、系统诊断记录恢复、企微助手二维码均已验证。
- 3131 与 3132 健康检查均返回 200。

## 注意事项

- 3131/3132 当前都是本地验证服务。用户实际常用地址是 `http://localhost:3131/admin`。
- 如果服务重启，Admin cookie 会失效，需要重新登录。这是当前内存 session 设计导致的，不是浏览器问题。
- 想减少“掉线感”，下一步可考虑将 admin session 存入数据库，或给本地开发模式提供持久 session secret / remember-me 机制。
- 当前工作区仍有未提交临时文件：`_import_code.cjs`、`admin-console-home.png`、`admin-console-natural.png`、`admin-support-sidebar.png`、`admin-wecom-helper.png`、`temp-sections/`、`temp_doc_reader.py`、`{console.error(e)`。这些未纳入 commit。
