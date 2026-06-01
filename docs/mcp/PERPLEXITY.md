# 将 GBrain 连接到 Perplexity Computer

Perplexity Computer 支持带 bearer token 认证的远程 MCP 服务器。

## 设置

1. 打开 Perplexity（需要 Pro 订阅）
2. 前往 **设置 > 连接器**（或 **MCP 服务器**）
3. 添加新的远程连接器：
   - **URL：** `https://YOUR-DOMAIN.ngrok.app/mcp`
   - **认证方式：** API Key / Bearer Token
   - **Token：** 你的 GBrain 访问 token
     （使用 `gbrain auth create "perplexity"` 创建一个）
4. 保存

将 `YOUR-DOMAIN` 替换为你的 ngrok 域名（设置方法参见
[ngrok-tunnel 配方](../../recipes/ngrok-tunnel.md)）。

## 验证

在 Perplexity 对话中，让它使用你的大脑：

```
使用我的 GBrain 搜索 [主题]
```

## 注意事项

- Perplexity Computer 对 Pro 订阅用户开放
- Perplexity Mac 应用和网页版均支持 MCP 连接器
- 如果你更喜欢 `gbrain serve`（stdio），Mac 应用也支持本地 MCP 服务器
