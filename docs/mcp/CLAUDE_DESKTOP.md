# 将 GBrain 连接到 Claude Desktop

**重要提示：** Claude Desktop 无法通过
`claude_desktop_config.json` 连接到远程 MCP 服务器。该文件仅适用于本地 stdio 服务器。
远程 HTTP 服务器必须通过 GUI 添加。

## 设置

1. 打开 Claude Desktop
2. 前往 **设置 > 集成**
3. 点击 **添加集成**（或 **添加连接器**）
4. 输入 MCP 服务器 URL：
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
   将 `YOUR-DOMAIN` 替换为你的 ngrok 域名（设置方法参见
   [ngrok-tunnel 配方](../../recipes/ngrok-tunnel.md)）。
5. 将认证方式设置为 **Bearer Token** 并粘贴你的令牌
   （使用 `gbrain auth create "claude-desktop"` 创建一个）
6. 保存

## 验证

开始新对话并尝试：

```
搜索我的大脑中关于 [任意主题]
```

Claude Desktop 将自动使用你的 GBrain 工具。

## 常见错误

**对远程服务器使用 claude_desktop_config.json** — 这会静默失败，
没有任何错误消息。JSON 配置仅适用于本地 stdio MCP 服务器。
远程 HTTP 服务器必须通过 GUI 中的设置 > 集成添加。

**使用错误的 URL** — 确保 URL 以 `/mcp` 结尾（而不是 `/health`
或仅仅是基础域名）。
