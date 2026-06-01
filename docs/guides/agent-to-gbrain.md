# 下游 agent 如何与 gbrain 通信

本指南适用于需要从其自己的运行时调用 gbrain 操作的下游 agents（hermes、openclaw、future forks）的作者。首先阅读本指南将为你节省一个调试周期：gbrain 有两个截然不同的接口，选择哪一个取决于操作。

## 两个接口

```
                       ┌─────────────────────────────────────┐
                       │                gbrain process                │
                       │                                              │
   Agent (hermes,      │  ┌──────────────────┐    ┌────────────────┐ │
   openclaw, fork) ────┼──▶  MCP ops surface  │    │   localOnly    │ │
                       │  │ (HTTP + OAuth)    │    │   admin ops    │ │
                       │  │                   │    │                │ │
                       │  │  search, query,   │    │  sync, embed,  │ │
                       │  │  put_page,        │    │  dream, doctor,│ │
                       │  │  get_page,        │    │  autopilot,    │ │
                       │  │  find_experts,    │    │  init, secrets │ │
                       │  │  ...              │    │                │ │
                       │  └──────────────────┘    └────────────────┘ │
                       │           ▲                       ▲          │
                       │           │                       │          │
                       │           │                       │          │
                       │     thin-client OAuth      shell-job `inherit:`│
                       │     (preferred for          (only path for   │
                       │      MCP-equivalent ops)    localOnly ops)   │
                       └─────────────────────────────────────────────┘
```

这两个接口**不可互换**。按操作选择，而不是按偏好。

## 接口 1 — 通过 HTTP 的 MCP 操作（thin-client + OAuth）

用于任何具有 MCP 等效项的操作：`search`、`query`、`put_page`、`get_page`、`find_experts`、`find_orphans`、`find_anomalies`、`get_recent_salience`、`find_trajectory` 等。规范列表是 `src/core/operations.ts` 中 `localOnly` 标志未设置（或为 `false`）的操作集。

### 设置

主机将 gbrain 作为长时间运行的 HTTP 服务器运行：

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain serve --http --port 3131
```

Agent 注册为 OAuth 客户端（一次性）：

```bash
gbrain auth register-client hermes \
  --grant-types client_credentials \
  --scopes read,write
# 一次性打印 client_id + client_secret。安全存储。
```

Agent 的运行时使用来自 `client_credentials` 授权的 bearer token 调用 `/mcp`。密钥保留在 gbrain serve 进程中；agent 永远不会看到 DATABASE_URL 或 API 密钥。

Thin-client 模式（`gbrain init --mcp-only`）为 agent 提供相同的客户端凭据连接，加上 `gbrain` CLI 本身通过配置的远程 MCP 路由支持 MCP 的操作。Agent 可以直接调用 `gbrain search` / `gbrain query`，CLI 会处理 OAuth 流程。

### 为什么这是 MCP 操作的首选

- 密钥永远不会离开服务器进程。
- OAuth 作用域为你提供 `read`、`write`、`admin` 分离 — agent 仅获得它需要的内容。
- 源作用域 token（`register-client` 上的 `--source dept-x`）将 agent 限制为联邦 brain 中的特定源。
- 一个审计接口（`mcp_request_log`）统一覆盖每个操作调用。

## 接口 2 — 通过 shell-job `inherit:` 的 localOnly 管理操作

某些操作在 `src/core/operations.ts` 中标记为 `localOnly: true`，并且在 `src/cli.ts:isThinClient` 处**被拒绝**在 thin-client 模式中。完整列表（截至 v0.36.5.0）包括：

- `sync`（文件系统遍历需要本地 FS 访问）
- `embed`（编排嵌入管道）
- `extract`（遍历 markdown 文件）
- `dream`（综合循环）
- `doctor`（文件系统健康检查）
- `autopilot`（后台守护进程编排）
- `init`（创建 `~/.gbrain/`）
- `secrets`（配置管理）

对于这些操作，agent 无法通过 HTTP MCP 路由。唯一的路径是将 `gbrain` 作为 CLI 子进程运行。推荐的模式是将子进程作为 shell job 提交给 gbrain Minions worker，以便重试 / 退避 / DLQ / 审计跟踪全部免费获得。

### 设置

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed && gbrain embed --stale",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}'
```

`inherit: ["database_url"]` 字段告诉 worker 从其 `loadConfig()` 中查找 `database_url` 并将值作为 `GBRAIN_DATABASE_URL` 注入到子进程环境中。`minion_jobs.data` 中的数据库行仅携带名称 — `inherit: ["database_url"]` — 永远不会携带值。有关完整的验证规则和错误目录，请参阅 [minions-shell-jobs.md#secrets](./minions-shell-jobs.md#secrets)。

### 为什么这优于将密钥写入每个作业的 `env:`

- 在 v0.36.5.0 之前，调用者通过 `env:` 传递密钥：`{ "GBRAIN_DATABASE_URL": "postgresql://..." }`。URL 以明文形式落在 `minion_jobs.data` 和 shell-audit JSONL 中。任何具有 brain-DB 读取访问权限的人（或通过挂载的共享 brain）都会看到该 URL。从 v0.36.5.0 开始，这在入队前验证时被拒绝。错误消息将 `inherit: ["database_url"]` 命名为替代方案。

### Worker 设置（一次性，每个主机）

Agent 的主机需要一个处理 shell jobs 的 worker：

```bash
# 一次性内联执行（PGLite 或 Postgres）：
gbrain jobs submit shell --params '{...}' --follow

# 持久 worker（仅 Postgres — PGLite 使用 --follow 内联）：
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work
```

`GBRAIN_ALLOW_SHELL_JOBS=1` 是 worker 端的加入选择。没有它，shell jobs 将无限期地坐在 `waiting` 中。将其设置在 worker 进程环境上（或在你的 deploy unit / launchd plist 中），而不是按提交 — 提交者环境是 worker 环境的弱代理。

## 决策表

| 操作 | 接口 | 为什么 |
|---|---|---|
| `search` / `query` | 通过 thin-client 的 HTTP MCP | 具有 MCP 操作；OAuth 作用域。 |
| `get_page` / `list_pages` | HTTP MCP | 相同。 |
| `put_page` | HTTP MCP | 相同；适用时遵守子 agent 允许列表。 |
| `find_experts` / `find_orphans` | HTTP MCP | 相同。 |
| `sync` / `embed` / `extract` | Shell job + `inherit:` | `localOnly: true`。 |
| `dream` | Shell job + `inherit:` | `localOnly: true`。 |
| `doctor` | Shell job + `inherit:`（或无 inherit，如果无 DB） | `localOnly: true`。 |
| `autopilot` | 直接在主机上作为守护进程运行 | 长时间运行，不是 job 形状。 |
| `init` / `secrets` | 一次性主机设置 | 操作员操作，不是 agent 操作。 |

## 推荐模式

- **为不想出现在行中的密钥使用 `inherit:`。** 名称落在 `minion_jobs.data` 中；值在子生成时从 worker 的配置中解析。如果 brain DB 曾经穿越信任边界，密钥会保留在外面。
- **自由格式名称。** `inherit:` 接受 worker 上的任何 snake_case 配置键 — `database_url`、`anthropic_api_key`、`openai_api_key`、`voyage_api_key`、`groq_api_key`、`zeroentropy_api_key`，或你填入 `~/.gbrain/config.json` 的任何自定义字段。Agent 选择它需要的内容。
- **`env:` 仍然适用于非密钥值**，或者适用于你希望值在行中的情况（例如，审计流程稍后需要读取的不透明关联 token）。验证器不会质疑你。
- **永远不要尝试通过 thin-client MCP 路由 `localOnly` 操作。** 它将失败并显示 `localOnly op refused in thin-client mode`。使用 shell-job + `inherit:`（用于密钥）或 `env:`（用于非密钥）。

## 迁移：从 v0.36.5.0 之前

如果你的 agent 提交通过 `env:` 传递密钥的 shell jobs：

```jsonc
// v0.36.5.0 之前：有效，但 URL 以明文形式持久化在 minion_jobs.data 中。
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "env": { "GBRAIN_DATABASE_URL": "postgresql://..." }
}
```

切换到（推荐）：

```jsonc
// v0.36.5.0+：行中的名称，值在子生成时从 worker 配置中解析。
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}
```

确保 worker 主机配置了 `database_url`（通过 `gbrain config set database_url <value>` 或通过 worker 进程上的 `GBRAIN_DATABASE_URL` / `DATABASE_URL` 环境变量）。如果 worker 无法解析密钥，验证器将在提交时拒绝 job，并附带粘贴就绪的提示。

---
