# 部署 GBrain 远程 MCP 服务器

> **v0.26.0+：** `gbrain serve --http` 附带完整的 OAuth 2.1（客户端凭证、
> 授权码 + PKCE、刷新轮换、可选的 DCR）、嵌入式的 React 管理
> 仪表板（位于 `/admin`）、作用域操作以及实时 SSE 活动流。
> v0.26 之前的旧版 bearer token 仍然有效 — `verifyAccessToken` 会回退到
> `access_tokens` 表，并将旧 token 沿用为 `read+write+admin` 权限。
> 旧版回退仅支持 Postgres（因为 `access_tokens` 表仅在 Postgres 中存在）；
> OAuth 表在 PGLite 和 Postgres 上均可工作。参见 [SECURITY.md](../../SECURITY.md)
> 了解环境变量和可调的默认值。

从任何设备、任何 AI 客户端访问你的大脑。GBrain 提供两种传输方式：
`gbrain serve`（stdio）用于本地代理，以及 `gbrain serve --http`（v0.26.0+）
用于通过 OAuth 2.1 连接的远程客户端。

## 三种路径

### 本地 stdio（零设置）

```bash
gbrain serve
```

适用于 Claude Code、Cursor、Windsurf 以及任何支持 stdio 的 MCP 客户端。
无需服务器、隧道或令牌。适用于 PGLite 和 Postgres 引擎。

### 通过 OAuth 2.1 远程访问（推荐，v0.26.0+）

```bash
gbrain serve --http --port 3131
ngrok http 3131 --url your-brain.ngrok.app
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

内置 HTTP 传输，支持 OAuth 2.1、作用域操作、位于 `/admin` 的
管理仪表板以及实时 SSE 活动流。零外部依赖。这是
唯一适用于 ChatGPT 的路径（ChatGPT MCP 连接器要求 OAuth 2.1 + PKCE）。
只要服务器可通过 `http://localhost:<端口>` 以外的地址访问，
就必须传递 `--public-url` 参数，以便 OAuth 颁发者在
发现元数据中与客户端的访问地址匹配（RFC 8414 §3.3）。

支持的客户端：
- **ChatGPT** — 要求 OAuth 2.1 + PKCE。原生支持 `--http`。
- **Claude Desktop / Cowork** — OAuth 2.1 或旧版 bearer token。
- **Perplexity** — OAuth 2.1 客户端凭证授予。
- **Claude Code、Cursor、Windsurf** — 可使用 OAuth 或旧版 bearer。

参见下面的 [OAuth 2.1 设置](#oauth-21-setup-v100) 部分。

### 使用旧版 bearer token 远程访问（v0.26 之前的部署）— 仅限 Postgres

```
你的 AI 客户端（Claude Desktop、Perplexity 等）
  → ngrok 隧道 (https://YOUR-DOMAIN.ngrok.app)
  → gbrain serve --http（内置传输，带 bearer 认证）
  → Postgres（连接池或自托管）
```

这需要：
1. 一个 Postgres 支持的大脑（`access_tokens` 表仅存在于 Postgres 中；
   对 PGLite 安装运行 `gbrain serve --http` 会在启动时快速失败）
2. 一台运行 `gbrain serve --http` 的机器
3. 一个公共隧道（ngrok、Tailscale 或云主机）
4. 通过 `gbrain auth create <名称>` 创建的 bearer token

升级到 HTTP 服务器时，v1.0 之前的 token 会被沿用为 `read+write+admin` 作用域，
因此无需迁移。

## OAuth 2.1 设置（v0.26.0+）

### 1. 启动 HTTP 服务器

```bash
gbrain serve --http --port 3131
```

首次启动时，服务器会将一个 **管理员引导 token** 打印到 stderr：

```
管理员引导 token：3a1f9c...
打开 http://localhost:3131/admin 并粘贴它以登录。
```

保存此 token。打开 `http://localhost:3131/admin` 并粘贴它以访问
仪表板。仪表板显示实时活动、已注册的客户端、请求日志以及
每个客户端的配置导出。

> **v0.26.9+：** `mcp_request_log.params` 和实时 SSE 活动流默认
> 显示为编校后的摘要 `{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`。
> 已声明参数键会被保留（与操作的规范取交集）；未知的
> 键会被计数但永远不会显示名称，字节大小向上取整到 1KB，以便大小探测
> 攻击无法通过二分搜索找到秘密内容。在个人笔记本电脑上操作且希望
> 看到原始负载的用户，可以传递 `gbrain serve --http --log-full-params`（启动时
> 会触发响亮的 stderr 警告）。多租户部署应保留
> 编校后的默认设置。

### 2. 注册 OAuth 客户端

从 **`/admin` 仪表板** 注册客户端：

1. 点击 **注册客户端**。
2. 输入名称（例如 `perplexity`、`chatgpt`）。
3. 选择作用域：`read`、`write`、`admin`（复选框）。
4. 选择授予类型：机器对机器（Perplexity、
   Claude Desktop bearer 模式）使用 `client_credentials`，或
   基于浏览器的客户端使用带 PKCE 的 `authorization_code`（ChatGPT）。
5. 对于 `authorization_code` 客户端，粘贴重定向 URI。
6. 点击 **注册**。凭证显示模态框会显示一次 `client_id`（以及
   机密客户端的 `client_secret`）。立即复制或下载 JSON
   — 密钥在存储时会进行哈希处理，永远不会再次显示。

或者通过 CLI — 更适合脚本编写：

```bash
gbrain auth register-client perplexity \
  --grant-types client_credentials \
  --scopes "read write"
```

**v0.34 — 源作用域客户端。** 多源大脑可以使用新的 `--source` 和
`--federated-read` 标志，将客户端的写入权限
限定到一个源，并将其读取作用域限定到一个精选集合：

```bash
gbrain auth register-client dept-x-agent \
  --grant-types client_credentials \
  --scopes "read write" \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`--source` 控制写入权限 — `put_page` / `add_link` / 等仅
落到 `dept-x` 中。`--federated-read` 独立控制读取轴；
查询返回来自任何所列源的行列。省略这两个标志可获得
兼容 v0.33 的超级客户端形态。v0.34 之前的客户端会在
`gbrain upgrade` 时回填为 `source_id='default'`。

宿主仓库包装器可以通过编程方式注册：

```ts
await oauthProvider.registerClientManual(
  'perplexity',
  ['client_credentials'],
  'read write',
  [],  // redirect_uris，CC 为空
);
```

对于自助客户端注册（动态客户端注册，RFC 7591），
使用 `--enable-dcr` 启动服务器。DCR 默认关闭。

### 3. 暴露服务器

**v0.34 — 显式绑定。** `gbrain serve --http` 默认为 `127.0.0.1`。
要接受来自 ngrok 隧道（或任何非回环来源）的连接，
请使用 `--bind` 重新启动：

```bash
gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url https://your-brain.ngrok.app
```

当设置了 `--public-url` 但没有设置 `--bind` 时，启动时会在
stderr 触发 WARN，以便配置错误（"隧道已启动但我的代理收到
ECONNREFUSED"）变得明显。

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 3131 --url your-brain.ngrok.app
```

你的 OAuth 颁发者 URL 变为 `https://your-brain.ngrok.app`。MCP SDK 的
路由器在 `/.well-known/oauth-authorization-server` 暴露符合规范的
发现端点。

### 4. 作用域和 localOnly

每个操作都标记为 `read | write | admin`。四个操作是
`localOnly`，无论作用域如何都会通过 HTTP 拒绝：`sync_brain`、
`file_upload`、`file_list`、`file_url`。远程代理无法访问本地
文件系统表面区域。

| 作用域 | 允许的操作 |
|-------|---------------|
| `read` | `search`、`query`、`get_page`、`list_pages`、图遍历 |
| `write` | `put_page`、`delete_page`、`add_link`、`add_timeline_entry` |
| `admin` | 客户端管理、token 吊销、清理、仅本地操作 |

## 旧版 Bearer Token 设置

如果你尚未准备好迁移，可以继续使用 v0.26 之前的 bearer token。它们在 HTTP 服务器上
会被沿用为 `read+write+admin` 作用域。

### 1. 设置隧道

完整设置参见 [ngrok-tunnel 配方](../../recipes/ngrok-tunnel.md)。
快速版本：

```bash
brew install ngrok
ngrok config add-authtoken YOUR_TOKEN
ngrok http 8787 --url your-brain.ngrok.app  # Hobby 套餐可获得固定域名
```

### 2. 创建访问 token

```bash
# 为每个客户端创建一个 token
gbrain auth create "claude-desktop"

# 列出所有 token
gbrain auth list

# 吊销 token
gbrain auth revoke "claude-desktop"
```

Token 是按客户端创建的。为每个设备/应用创建一个。如果泄露，
可单独吊销。Token 以其 SHA-256 哈希形式存储在数据库中。

### 3. 连接你的 AI 客户端

- **ChatGPT：** [设置指南](CHATGPT.md)（OAuth 2.1 + PKCE，要求 `gbrain serve --http`）
- **Claude Code：** [设置指南](CLAUDE_CODE.md)
- **Claude Desktop：** [设置指南](CLAUDE_DESKTOP.md)（必须使用 GUI，而非 JSON 配置）
- **Claude Cowork：** [设置指南](CLAUDE_COWORK.md)
- **Perplexity：** [设置指南](PERPLEXITY.md)

### 4. 验证

```bash
gbrain auth test \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  --token YOUR_TOKEN
```

## 操作

所有 30 个 GBrain 操作均可远程使用，包括 `sync_brain` 和
`file_upload`（使用自托管服务器无超时限制）。

**关于 `file_upload` 的安全说明：** 远程 MCP 调用者被限制在启动
`gbrain serve` 时所在的工作目录中。符号链接、`..` 遍历以及
cwd 之外的绝对路径都会被拒绝。页面别名和文件名会通过
允许列表进行验证（字母数字 + 连字符；无控制字符、RTL 覆盖或反斜杠）。本地
CLI 调用者（`gbrain file upload ...`）保留不受限制的文件系统访问权限，因为
用户拥有该机器。

## 部署选项

参见 [ALTERNATIVES.md](ALTERNATIVES.md) 了解 ngrok、Tailscale
Funnel 和云主机（Fly.io、Railway）的对比。

## 故障排除

**"missing_auth" 错误**
包含 Authorization 头：`Authorization: Bearer YOUR_TOKEN`

**"invalid_token" 错误**
运行 `gbrain auth list` 查看活跃的 token。

**"service_unavailable" 错误**
数据库连接失败。检查你的 Supabase 仪表板是否有中断。

**Claude Desktop 无法连接**
远程服务器必须通过设置 > 集成添加，而不是通过
`claude_desktop_config.json`。参见 [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md)。

## 预期延迟

| 操作 | 典型延迟 | 说明 |
|-----------|----------------|-------|
| get_page | < 100ms | 单次数据库查询 |
| list_pages | < 200ms | 带过滤器的数据库查询 |
| search（关键词） | 100-300ms | 全文搜索 |
| query（混合） | 1-3s | 嵌入 + 向量 + 关键词 + RRF |
| put_page | 100-500ms | 写入 + 触发 search_vector 更新 |
| get_stats | < 100ms | 聚合查询 |

**注意：** `gbrain serve --http` 在 v0.26.0 中发布，OAuth 2.1 + 管理
仪表板已内置到二进制文件中。自定义 HTTP 包装器模式（参见
[语音配方](../../recipes/twilio-voice-brain.md)）仍然支持，适用于
需要定制中间件的团队，但对于大多数远程部署，
内置服务器是推荐的路径。
