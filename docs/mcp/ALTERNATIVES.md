# 远程 MCP 部署选项

GBrain 的 MCP 服务器通过 `gbrain serve`（stdio 传输）运行。若要从其他设备和 AI 客户端访问它，可以在公共隧道后面运行 `gbrain serve --http`（内置 HTTP 传输，支持 Bearer 认证，仅支持 Postgres……详见 [DEPLOY.md](DEPLOY.md)）。以下是可用的隧道选项。

## ngrok（推荐）

[ngrok](https://ngrok.com) 提供即时公共隧道。Hobby 套餐（$8/月）为你提供永久固定的域名，不会变更。

```bash
# 1. 安装 ngrok
brew install ngrok

# 2. 启动内置 HTTP 传输
gbrain serve --http --port 8787
# 详见 docs/mcp/DEPLOY.md 了解 token 设置

# 3. 通过 ngrok 暴露服务
ngrok http 8787 --url your-brain.ngrok.app
```

查看 [ngrok-tunnel 配方](../../recipes/ngrok-tunnel.md) 获取完整设置指南，包括认证 token 配置和固定域名设置。

## Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/tailscale-funnel) 为你提供永久公共 HTTPS URL，并自动配置 TLS。提供免费套餐。最适合你同时控制两端的私有网络。

```bash
# 1. 安装 Tailscale
brew install tailscale

# 2. 暴露你的 MCP 服务器
tailscale funnel 8787
# 你的大脑现在位于 https://your-machine.ts.net
```

## Fly.io / Railway（始终在线）

对于需要 7×24 小时运行而不依赖你本地机器的生产环境部署：

- **Fly.io：** $5-10/月，全球边缘节点，`fly deploy` 部署
- **Railway：** $5/月，git push 部署

两者都原生支持 Bun。无需打包，无需 Deno，无冷启动，无超时限制。

## 对比

| | ngrok | Tailscale | Fly.io/Railway |
|--|---|---|---|
| 费用 | $8/月（Hobby） | 免费 | $5-10/月 |
| 固定 URL | 是（Hobby） | 是 | 是 |
| 笔记本关机后可用 | 否 | 否 | 是 |
| 冷启动 | 无 | 无 | 无 |
| 超时限制 | 无 | 无 | 无 |
| 全部 30 个操作 | 是 | 是 | 是 |
| 设置时间 | 5 分钟 | 10 分钟 | 15 分钟 |

**注意：** `gbrain serve --http` 是内置 HTTP 传输（v0.22.7+）。通过对 `access_tokens` 表进行 Bearer 认证，默认拒绝 CORS，双桶限流，请求体大小限制，逐请求审计日志。设计上仅支持 Postgres（PGLite 仅限本地）。详见 [DEPLOY.md](DEPLOY.md) 和 [SECURITY.md](../../SECURITY.md) 了解环境变量和可调参数。
