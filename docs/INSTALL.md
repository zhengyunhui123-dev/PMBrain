# 安装

三条安装路径。选一条。以后可以混合。

## 1. 使用代理平台（推荐）

已经在运行 [OpenClaw](https://github.com/garrytan/openclaw) 或 [Hermes](https://github.com/garrytan/hermes)？

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite                  # 2 秒；无服务器
gbrain skillpack scaffold --all       # 43 个技能脚手架到你的代理工作区
gbrain doctor                         # 一路绿灯检查
```

你的代理现在每次请求读取 `skills/RESOLVER.md`，将意图路由到正确的技能，执行。新的实体提及会创建新页面。每日 cron 在夜间运行丰富。

脚手架技能是你代理仓库中的一级文件 — 自由编辑。以后要拉取上游 gbrain 改进，`gbrain skillpack reference <name>` 会比较你的本地副本与包。旧的 `skillpack install` 托管块模型在 v0.36.0.0 中已停用；如果你从旧版本升级，运行一次 `gbrain skillpack migrate-fence` 以剥离旧围栏并保留现有技能行。

以后升级：`gbrain upgrade` 运行模式迁移 + 升级后提示（chunker 版本提升，v0.36.2.0 ZeroEntropy 切换）。始终 TTY-only；非 TTY 升级跳过提示，带信息性 stderr 行。

## 2. CLI 独立版

无代理平台，只要 shell + 支持 MCP 的编辑器。

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite
```

> **如果 `bun install -g` 遇到 postinstall 错误**（Bun 在某些环境中阻止 postinstall 钩子），CLI 会打印指向 [#218](https://github.com/garrytan/gbrain/issues/218) 的恢复提示。运行 `gbrain doctor` 诊断，然后手动 `gbrain apply-migrations --yes`。确定性回退是 `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`。

初始化流程会检测你的仓库大小，并建议对超过 1000 个 markdown 文件的 brain 使用 Supabase。以后切换：

```bash
gbrain migrate --to supabase     # PGLite → Postgres
gbrain migrate --to pglite       # Postgres → PGLite（罕见）
```

对于共享 / 大型 / 多机器部署（团队或公司 brain，多个用户通过 HTTP MCP 访问一台服务器，每个用户有 OAuth 作用域），请遵循专用演练：** [教程：将 GBrain 设置为你的公司 brain](tutorials/company-brain.md)**。

API 密钥位于 `~/.gbrain/config.json`（文件平面）或环境变量（`OPENAI_API_KEY`、`ZEROENTROPY_API_KEY`、`VOYAGE_API_KEY`、`ANTHROPIC_API_KEY`）。通过 CLI 设置：

```bash
gbrain config set zeroentropy_api_key sk-...
gbrain config set anthropic_api_key sk-ant-...
```

常见后续操作：

```bash
gbrain import ~/my-knowledge      # 批量导入 markdown 文件夹
gbrain sync --watch               # 实时同步 git 仓库（自动 Pilot 模式）
gbrain autopilot --install        # 用于夜间丰富的后台守护进程
```

## 3. MCP 服务器（任何 MCP 客户端）

```bash
gbrain serve                      # stdio MCP（Claude Desktop / Code / Cursor）
gbrain serve --http               # HTTP MCP，带 OAuth 2.1 + 管理仪表板
```

每客户端设置指南位于 [`docs/mcp/`](mcp/)：

- [`docs/mcp/CLAUDE_CODE.md`](mcp/CLAUDE_CODE.md)
- [`docs/mcp/CLAUDE_DESKTOP.md`](mcp/CLAUDE_DESKTOP.md)
- [`docs/mcp/CHATGPT.md`](mcp/CHATGPT.md)
- [`docs/mcp/PERPLEXITY.md`](mcp/PERPLEXITY.md)
- [`docs/mcp/DEPLOY.md`](mcp/DEPLOY.md) — 生产部署模式

HTTP 服务器附带 `/admin` 处的管理 SPA、`/admin/events` 处的 SSE 活动流、DCR 风格的客户端注册、作用域门控的 `read`/`write`/`admin` 访问以及速率限制。

## 瘦客户端模式

连接到别人的 brain，无需运行本地引擎：

```bash
gbrain init --mcp-only            # 配置远程 MCP，跳过本地数据库
```

适用于：团队挂载、brain-as-a-service 部署、没有磁盘空间的开发机器。大多数本地命令会拒绝并给出可粘贴的提示。见 [`docs/architecture/topologies.md`](architecture/topologies.md)。

## 验证安装

```bash
gbrain doctor --json              # 完整健康检查
gbrain models                     # 哪些 AI 模型配置用于什么
gbrain models doctor              # 每个配置模型的 1-token 探测
```

如果有任何黄色项，`gbrain doctor` 会在消息中给出修复命令。大多数问题是因为缺少 API 密钥或陈旧的模式（`gbrain upgrade --force-schema`）。
