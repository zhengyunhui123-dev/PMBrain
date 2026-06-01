# 安全

## 报告漏洞

如果你在 GBrain 中发现安全问题，请通过在 GitHub 上打开
[私有安全公告](https://github.com/garrytan/gbrain/security/advisories/new)
私下报告。

不要为安全漏洞打开公共 issue。

## 远程 MCP 安全

### ⚠️ 不要为远程 MCP 使用开放 OAuth 客户端注册

如果你在支持 OAuth 2.1 的 HTTP 包装器后面部署 GBrain 的 MCP 服务器，
**永远不要允许未经身份验证的客户端注册**。攻击者
如果发现你的服务器 URL 可以：

1. 通过 `POST /register` 注册新的 OAuth 客户端
2. 使用 `client_credentials` 授权获取承载令牌
3. 通过 MCP 工具访问所有大脑数据

### 推荐：`gbrain serve --http`

从 v0.22.7 开始，GBrain 提供了一个内置的 HTTP 传输，使用
现有的 `access_tokens` 表进行身份验证：

```bash
# 创建令牌
gbrain auth create "my-client"

# 启动 HTTP 服务器
gbrain serve --http --port 8787

# 通过 ngrok、Tailscale 或任何隧道连接
ngrok http 8787 --url your-brain.ngrok.app
```

这是远程暴露 GBrain 的推荐方法。没有 OAuth，没有
注册端点，没有自助服务令牌。令牌管理
仅通过 `gbrain auth create/list/revoke` 进行。

### 如果你必须使用自定义 HTTP 包装器

1. **客户端注册需要密钥** — 在创建新的 OAuth 客户端之前检查标头或正文
   参数
2. **禁用 `client_credentials` 授权** — 仅允许 `authorization_code`
   并需要基于浏览器的批准
3. **限制范围** — 永远不要颁发具有无限范围的令牌
4. **记录所有令牌颁发** — 对意外注册发出警报
5. **限制注册和令牌端点的速率**

### 在没有 DCR 的情况下预注册 claude.ai / ChatGPT 客户端 (v0.41.3+)

上面推荐的强化姿态是：发布 `gbrain serve --http`
**不带** `--enable-dcr` 并手动预注册每个客户端。从
v0.41.3 开始，`gbrain auth register-client` 接受基于浏览器的客户端需要的 OAuth 字段：

```bash
# 预注册 claude.ai（机密客户端；两个重定向 URI）
gbrain auth register-client claude-ai \
  --scopes "read write" \
  --redirect-uri https://claude.ai/api/mcp/auth_callback \
  --redirect-uri https://claude.com/api/mcp/auth_callback
# 当传递 --redirect-uri 时，--grant-types 自动设置为 authorization_code,refresh_token；
# 显式传递 --grant-types 以覆盖。

# 预注册 ChatGPT（公共 PKCE 客户端；不生成 client_secret）
gbrain auth register-client chatgpt \
  --scopes "read write" \
  --redirect-uri https://chatgpt.com/connector/oauth/<HASH> \
  --token-endpoint-auth-method none
```

认证方法（`--token-endpoint-auth-method`）：

- `client_secret_post`（默认）— 机密客户端，秘密在正文中
- `client_secret_basic` — 机密客户端，秘密在 `Authorization` 标头中
- `none` — 仅公共 PKCE 客户端（不生成秘密；ChatGPT 自定义
  连接器、Claude Code、Cursor）

验证器在注册边界拒绝未知方法，并且
相同的门控适用于管理端点 `POST /admin/api/register-client`
和 DCR `POST /register` 路径。v0.41.3 之前，CLI 硬编码了
`redirect_uris = []` 和 `token_endpoint_auth_method = NULL`，强制
操作员手动 UPDATE `oauth_clients` 行以使 claude.ai 在没有
`--enable-dcr` 的情况下工作。那个隐患已经消除了。

### 令牌管理

```bash
gbrain auth create "claude-desktop"   # 创建新令牌
gbrain auth list                       # 列出所有令牌
gbrain auth revoke "claude-desktop"    # 撤销令牌
gbrain auth test <url> --token <tok>   # 冒烟测试远程服务器
```

令牌以 SHA-256 哈希形式存储在 `access_tokens` 表中。
明文令牌在创建时显示一次，之后永远不会存储。

## `gbrain serve --http` 加固 (v0.22.7+)

内置的 HTTP 传输默认附带多个加固层。
默认情况下都是启用的。以下所有环境变量都是可选的；默认值特意
设置为保守的。

### 绑定地址（v0.34：默认环回）

`gbrain serve --http` 默认监听 `127.0.0.1`。个人笔记本电脑
安装不会意外地将大脑发布到局域网。自托管
需要远程访问的部署传递 `--bind 0.0.0.0`（所有
接口）或 `--bind <interface-ip>`（特定 NIC）。当设置 `--public-url` 而没有 `--bind` 时，会触发 stderr WARN，以便操作员在第一个请求之前看到
绑定 — 这是"ngrok 转发到我但这里代理无法到达上游"配置错误的常见原因。

### 仅限 Postgres

`gbrain serve --http` 需要 Postgres 引擎。PGLite 按设计仅是本地的，
并且 `access_tokens` / `mcp_request_log` 表在
PGLite 模式中不存在。本地代理继续使用 stdio (`gbrain serve`)。
对基于 PGLite 的安装运行 `--http` 会在启动时快速失败，并显示清晰的
错误消息。

### CORS

默认拒绝：除非配置了允许列表，否则不会发送 `Access-Control-Allow-Origin` 标头。要允许基于浏览器的 MCP 客户端：

```bash
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai gbrain serve --http --port 8787
# 多个源：逗号分隔
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai,https://your.app gbrain serve --http
```

当请求 `Origin` 与允许列表匹配时，服务器会在 `Access-Control-Allow-Origin` 中回显它（带有 `Vary: Origin`）。否则不会发送
CORS 标头，浏览器会阻止请求。

**v0.41.3：** 现在相同的允许列表控制每个 OAuth 端点（`/mcp`、
`/token`、`/authorize`、`/register`、`/revoke`）。v0.41.3 之前这些使用
默认完全开放的 `cors()` 中间件，在每个响应中泄漏
`Access-Control-Allow-Origin: *` — 任何 Web 源都可以
从登录的操作员浏览器完成令牌交换。传统 bearer 传输中的 CORS
预检处理程序也是不对称的
（实际请求路径正确默认拒绝，但 OPTIONS 预检泄漏了
每个源的 `Access-Control-Allow-Methods` + `Access-Control-Allow-Headers`）；现在两者都通过单个允许列表控制的路径合并。
当设置 `--bind 0.0.0.0` 而没有
`GBRAIN_HTTP_CORS_ORIGIN` 时，会触发启动 stderr WARN，在第一个请求之前显示默认拒绝姿态。

### 速率限制

两个桶，都存储在有限的 LRU 映射中（默认 10K 密钥，溢出时驱逐
最近最少使用的，修剪早于 2× 的条目
窗口）：

| 桶 | 触发时机 | 默认值 | 环境变量 |
|---|---|---|---|
| 认证前 IP | 在数据库查找之前，每个 `/mcp` 请求 | 30 请求 / 60秒 | `GBRAIN_HTTP_RATE_LIMIT_IP` |
| 认证后令牌 | 解析有效令牌后 | 60 请求 / 60秒 | `GBRAIN_HTTP_RATE_LIMIT_TOKEN` |
| LRU 上限 | 两个桶的最大不同密钥数 | 10000 | `GBRAIN_HTTP_RATE_LIMIT_LRU` |

耗尽时，服务器返回 `429 Too Many Requests` 并带有一个
`Retry-After` 标头。

**隧道部署的注意事项（ngrok、Tailscale Funnel、Cloudflare
Tunnel）：** 所有请求共享一个出口 IP，因此认证前 IP 桶
实际上由该隧道上的所有客户端共享。
认证后令牌 ID 桶是隧道前端部署的承载限制器。

### 反向代理信任

**默认仅环回**（v0.41.3+ Express 服务器与
传统传输一致；v0.41.3 之前 Express 服务器硬编码了 `'loopback'`
而文档声称"默认禁用" — 那个分歧已经消失了）。
默认仅信任同一主机代理（127.0.0.1、::1、fc00::/7）；
无论如何都会忽略外部 forwarded-for 标头。要扩大或
缩小信任：

```bash
# 精确信任一跳 — Fly.io、Render、Vercel、单层 nginx
GBRAIN_HTTP_TRUST_PROXY=1 gbrain serve --http --port 8787

# 信任 N 跳 — Cloudflare → nginx → gbrain
GBRAIN_HTTP_TRUST_PROXY=2 gbrain serve --http --port 8787

# 完全禁用 — 没有代理的直接暴露部署
GBRAIN_HTTP_TRUST_PROXY=0 gbrain serve --http --port 8787

# 命名的 Express 模式（uniquelocal、linklocal）或 CIDR 列表通过
GBRAIN_HTTP_TRUST_PROXY=uniquelocal gbrain serve --http --port 8787
GBRAIN_HTTP_TRUST_PROXY="10.0.0.0/8,192.168.1.0/24" gbrain serve --http --port 8787
```

两种传输（`src/commands/serve-http.ts` 中的 Express OAuth 服务器和
`src/mcp/http-transport.ts` 中的传统 bearer 传输）读取相同的
环境变量，因此单一事实来源。

**关键安全契约：** 仅当 **以下两项**
都为真时才扩大到 `'loopback'` 之外：

1. gbrain 仅通过受信任的反向代理可访问（不直接
   在配置的端口上暴露到互联网）。从 v0.34 开始，
   `gbrain serve --http` 默认绑定 `127.0.0.1`，因此
   仅反向代理姿态是开箱即用的形状；仅当
   gbrain 本身需要直接接受远程连接时，才使用 `--bind 0.0.0.0`（或特定的接口 IP）覆盖。
2. 代理会剥离任何客户端提供的 `X-Forwarded-For` 和 `X-Real-IP`
   标头，然后自己设置它们。（带有 `proxy_set_header
   X-Forwarded-For $remote_addr` 的 nginx 会这样做；Cloudflare 和大多数云
   负载均衡器会自动处理它。）

如果 gbrain 可直接访问 **并且** 设置了 `GBRAIN_HTTP_TRUST_PROXY=1`（或任何
非环回值），客户端可以通过发送
任意 `X-Forwarded-For` 标头来欺骗其 IP，从而绕过认证前 IP 速率
限制。通过忽略所有
forwarded-for 标头并使用套接字对等地址，`'loopback'` 默认值可以防止这种情况。

### 正文大小限制

默认 1 MiB，流式计数（没有
`Content-Length` 的分块传输仍然受限制）。覆盖：

```bash
GBRAIN_HTTP_MAX_BODY_BYTES=2097152 gbrain serve --http   # 2 MiB
```

超过限制的请求会立即获得 `413 Payload Too Large`，在任何
正文在内存中实现之前。

### 审计日志

每个 `/mcp` 请求向 `mcp_request_log` 写入一行：

```bash
psql "$DATABASE_URL" -c \
  "SELECT created_at, token_name, operation, status, latency_ms
   FROM mcp_request_log
   ORDER BY created_at DESC LIMIT 100"
```

`status` 是以下之一：`success`、`error`、`auth_failed`、`rate_limited`、
`body_too_large`、`parse_error`、`unknown_method`。认证失败的行具有
`token_name = NULL`。插入是即发即弃的，因此审计失败
永远不会阻止请求。

**v0.26.9 编辑默认值。** `params` 列现在存储
`{redacted, kind, declared_keys, unknown_key_count, approx_bytes}` 而不是
原始 JSON-RPC 负载。声明的密钥（与操作的
规范相交）保留用于调试可见性；未知的密钥被计数但永远不会
命名，因此攻击者无法探测密钥存在；字节大小分桶到 1KB，因此
内容大小无法被二分搜索。相同的形状在
`/admin/events` 的管理 SSE 源上广播。在个人笔记本电脑上想要
原始负载回来的操作员可以传递 `gbrain serve --http --log-full-params`（在启动时发出
stderr 警告）。多租户部署应该将其保留在
编辑后的默认值上。
