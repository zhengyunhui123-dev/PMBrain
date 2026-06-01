# 将 GBrain 连接到 Claude Cowork

有两种方式可以将 GBrain 接入 Cowork 会话：

## 选项 1：远程（通过自托管服务器 + 隧道）

对于 Team/Enterprise 计划，组织所有者添加连接器：

1. 前往 **组织设置 > 连接器**
2. 使用 MCP 服务器 URL 添加新连接器：
   ```
   https://YOUR-DOMAIN.ngrok.app/mcp
   ```
3. 在高级设置中添加 Bearer token 认证
   （使用 `gbrain auth create "cowork"` 创建一个）
4. 保存

注意：Cowork 从 Anthropic 的云连接，而不是你的设备。你的服务器
必须可从公共网络访问（ngrok、Tailscale Funnel 或云托管）。

## 选项 2：本地桥接（通过 Claude Desktop）

如果你已经在 Claude Desktop 中配置了 GBrain（通过 `gbrain serve`
stdio 或远程集成），Cowork 会自动获得访问权限。Claude
Desktop 通过其 SDK 层将本地 MCP 服务器桥接到 Cowork。

这意味着：如果 `gbrain serve` 正在运行并且在 Claude Desktop 中已配置，
你不需要为 Cowork 单独设置服务器。

## 使用哪一个？

- **远程服务器：** 即使你的笔记本电脑已关闭也能工作，可供所有组织成员使用
- **本地桥接：** 如果 Claude Desktop 已有 GBrain 则无需额外设置，但需要你的机器正在运行
