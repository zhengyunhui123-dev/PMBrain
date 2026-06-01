# 将 GBrain 连接到 Claude Code

## 选项 1：本地（推荐，无需服务器）

```bash
claude mcp add gbrain -- gbrain serve
```

就这样。Claude Code 会生成 `gbrain serve` 作为 stdio 子进程。无需服务器、隧道或令牌。适用于 PGLite 和 Supabase 引擎。

## 选项 2：远程（从任何机器访问）

如果你在带有公共隧道的服务器上运行 GBrain（参见 [ngrok-tunnel 配方](../../recipes/ngrok-tunnel.md)）：

```bash
claude mcp add gbrain -t http \
  https://YOUR-DOMAIN.ngrok.app/mcp \
  -H "Authorization: Bearer YOUR_TOKEN"
```

将 `YOUR-DOMAIN` 替换为你的 ngrok 域名，将 `YOUR_TOKEN` 替换为来自 `gbrain auth create "claude-code"` 的令牌。

## 验证

在 Claude Code 中，尝试：

```
搜索 [你大脑中的任何主题]
```

你应该会看到来自 GBrain 知识库的结果。

## 移除

```bash
claude mcp remove gbrain
```
