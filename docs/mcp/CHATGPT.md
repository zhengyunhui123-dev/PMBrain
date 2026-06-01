# 将 GBrain 连接到 ChatGPT

**状态 (v0.26.0)：** 已解除限制。GBrain 的 `gbrain serve --http` 附带 OAuth 2.1
和 PKCE，这是 ChatGPT MCP 连接器的硬性要求。在 v1.0 之前，
这是一个 P0 待办事项 — 是唯一无法连接的主流 AI 客户端。

ChatGPT 不支持 bearer-token MCP 服务器。你必须使用 OAuth 2.1
HTTP 服务器。

## 设置

### 1. 启动 HTTP 服务器

```bash
gbrain serve --http --port 3131
```

保存打印到 stderr 的管理员引导 token。打开
`http://localhost:3131/admin` 并粘贴它以访问仪表板。

### 2. 注册 ChatGPT 客户端

ChatGPT 使用带 PKCE 的授权码流程（基于浏览器的 OAuth）。
从 `/admin` 仪表板注册：

1. 点击 **注册客户端**。
2. 名称：`chatgpt`。
3. 授权类型：`authorization_code`。
4. 作用域：`read`、`write`（ChatGPT 不要勾选 `admin`）。
5. 重定向 URI：ChatGPT 的 OAuth 重定向（从 ChatGPT
   连接器设置屏幕复制 — 类似于
   `https://chat.openai.com/connector_platform_oauth_redirect`）。
6. 点击 **注册**。凭证显示模态框会显示一次 `client_id`，
   带有复制和下载 JSON 按钮。基于 PKCE 的公共客户端没有客户端密钥。

宿主仓库包装器可以通过编程方式注册：

```ts
await oauthProvider.registerClientManual(
  'chatgpt',
  ['authorization_code'],
  'read write',
  ['https://chat.openai.com/connector_platform_oauth_redirect'],
);
```

### 3. 公开暴露服务器

```bash
brew install ngrok
ngrok http 3131 --url your-brain.ngrok.app
```

你的 OAuth 颁发者 URL 变为 `https://your-brain.ngrok.app`。ChatGPT 的
连接器自动发现符合规范的端点在
`/.well-known/oauth-authorization-server`。

### 4. 在 ChatGPT 中添加连接器

1. 打开 ChatGPT > 设置 > 连接器。
2. 点击 **添加连接器**。
3. MCP 服务器 URL：`https://your-brain.ngrok.app/mcp`。
4. 客户端 ID：你在步骤 2 中保存的 `client_id`。
5. 点击 **连接**。ChatGPT 打开 OAuth 同意页面，你批准，
   连接器即生效。

开始新对话并让 ChatGPT 搜索你的大脑。MCP 工具
调用会实时显示在所述仪表板的实时 SSE 流中。

## 作用域

ChatGPT 客户端可以请求 `read`、`write`、`admin` 的任意组合。
在同意时授予的作用域会在每次工具调用时强制执行。四个
操作是 `localOnly`，无论作用域如何都会通过 HTTP 拒绝：
`sync_brain`、`file_upload`、`file_list`、`file_url`。HTTP 服务器
对任何尝试访问本地文件系统表面的请求都会失败关闭。

推荐的 ChatGPT 作用域：`read write`。将 `admin` 留给你的本地 CLI
和所述仪表板。

## 故障排除

**ChatGPT 连接器 OAuth 握手期间"无效 redirect_uri"**
注册的重定向 URI 必须与 ChatGPT 的完全一致。如果 ChatGPT
拒绝你的服务器，检查所述仪表板的 **代理** 表以查找
客户端，确认重定向 URI 与错误页面显示的匹配，并
使用正确的 URI 重新注册。

**批准后 ChatGPT 显示 MCP 连接错误**
打开 `/admin`，观看 SSE 流，然后重试。如果没有请求到达，则
连接器无法访问你的 ngrok URL。如果请求到达但失败，
则请求日志选项卡显示确切错误。

**令牌端点上"不支持的 grant_type"**
ChatGPT 使用 `authorization_code`，MCP SDK 原生支持它。
如果你看到此错误，请验证客户端是否使用
`--grant-types authorization_code` 而非 `client_credentials` 注册。

## 另请参阅

- [DEPLOY.md](DEPLOY.md) — 完整 OAuth 2.1 设置参考
- [ALTERNATIVES.md](ALTERNATIVES.md) — 隧道选项（ngrok、Tailscale、Fly）
