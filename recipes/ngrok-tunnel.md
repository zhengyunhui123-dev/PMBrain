---
id: ngrok-tunnel
name: Public Tunnel
version: 0.7.0
description: 您的大脑的固定公共 URL（MCP 服务器、语音代理、任何服务）。一个 ngrok 账户，永不更改。
category: infra
requires: []
secrets:
  - name: NGROK_AUTHTOKEN
    description: ngrok 认证令牌（推荐 Hobby 层以获得固定域名）
    where: https://dashboard.ngrok.com/get-started/your-authtoken — 注册，然后复制您的 authtoken
health_checks:
  - type: command
    argv: ["pgrep", "-f", "ngrok.*http"]
    label: "ngrok process"
  - type: http
    url: "http://localhost:4040/api/tunnels"
    label: "ngrok API"
setup_time: 10 min
cost_estimate: "$8/月 for Hobby 层（固定域名）。免费层可以工作，但 URL 在重启时更改。"
---

# Public Tunnel：您的大脑的固定 URL

您的 GBrain MCP 服务器和语音代理需要公共 URL，以便 Claude Desktop、
Perplexity 和 Twilio 可以访问它们。ngrok 为您提供一个
永不更改的固定域名。

## 重要：给代理的说明

**您是安装程序。** 这是基础架构。其他配方
（voice-to-brain、remote MCP）依赖于此。首先设置它。

**为什么这很重要：**
- Voice-to-brain 需要公共 URL 用于 Twilio webhook
- Remote MCP 需要公共 URL 用于 Claude Desktop 和 Perplexity
- 免费的 ngrok URL 在每次重启时都会更改，破坏所有集成
- Hobby 层（$8/月）提供固定域名。设置一次，再也不碰它。

**不要跳过步骤。在每个步骤后验证。**

## 架构

```
本地服务（您的机器）
  ├── GBrain MCP 服务器（端口 3000）    gbrain serve
  └── 语音代理（端口 8765）          node server.mjs
         │
         ▼
ngrok tunnel（固定域名）
  └── https://your-brain.ngrok.app
         │
         ├── /mcp   → Claude Desktop、Claude Code、Perplexity
         └── /voice  → Twilio webhooks
```

## 设置流程

### 步骤 1：创建 ngrok 账户 + 获取 Hobby 层

告诉用户：
"我需要您创建一个 ngrok 账户。我强烈推荐 Hobby 层（$8/月）
以获得一个永不更改的固定域名。没有它，每次重启都会破坏您的
Twilio webhook 和 Claude Desktop 连接。

1. 转到 https://dashboard.ngrok.com/signup（注册）
2. 转到 https://dashboard.ngrok.com/billing 并升级到 **Hobby**（$8/月）
3. 转到 https://dashboard.ngrok.com/get-started/your-authtoken
4. 复制您的 **Authtoken** 并粘贴给我"

验证：
```bash
ngrok config add-authtoken $NGROK_AUTHTOKEN \
  && echo "通过：ngrok 已配置" \
  || echo "失败：ngrok 认证令牌被拒绝"
```

如果未安装 ngrok：
- **Mac：** `brew install ngrok`
- **Linux：** `curl -sL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C /usr/local/bin`

**停止直到 ngrok 验证通过。**

### 步骤 2：声明固定域名

告诉用户：
"1. 转到 https://dashboard.ngrok.com/domains
2. 点击 **'+ New Domain'**
3. 选择一个名称（例如，`your-brain.ngrok.app`）
4. 点击 **'Create'**
5. 告诉我您选择的域名"

如果用户停留在免费层（无固定域名），请注意 URL 将在
重启时更改，watchdog 将需要更新 Twilio。建议稍后升级。

### 步骤 3：启动 Tunnel

```bash
# 使用固定域名（Hobby）：
ngrok http 8765 --url your-brain.ngrok.app

# 不使用固定域名（免费）：
ngrok http 8765
```

验证：
```bash
curl -sf http://localhost:4040/api/tunnels \
  && echo "通过：ngrok tunnel 活动" \
  || echo "失败：ngrok 未运行"
```

### 步骤 4：设置 Watchdog

tunnel 必须在死机时自动重启。创建一个 watchdog：

```bash
#!/bin/bash
# ngrok-watchdog.sh — 每 2 分钟通过 cron 运行

# 检查 ngrok 是否正在运行
if ! pgrep -f "ngrok.*http" > /dev/null 2>&1; then
  echo "[watchdog] ngrok 未运行 — 正在启动..."

  # 如果缺少则安装
  if ! command -v ngrok > /dev/null 2>&1; then
    echo "[watchdog] ngrok 未安装"
    exit 1
  fi

  # 使用固定域名启动（如果已配置）或免费
  if [ -n "$NGROK_DOMAIN" ]; then
    nohup ngrok http 8765 --url "$NGROK_DOMAIN" > /dev/null 2>&1 &
  else
    nohup ngrok http 8765 > /dev/null 2>&1 &
  fi
  sleep 5

  # 如果没有固定域名，使用新 URL 更新 Twilio webhook
  if [ -z "$NGROK_DOMAIN" ] && [ -n "$TWILIO_ACCOUNT_SID" ]; then
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
      | grep -o '"public_url":"https://[^"]*' | grep -o 'https://.*')
    if [ -n "$NGROK_URL" ] && [ -n "$TWILIO_NUMBER_SID" ]; then
      curl -s -X POST -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
        "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$TWILIO_NUMBER_SID.json" \
        -d "VoiceUrl=${NGROK_URL}/voice" > /dev/null
      echo "[watchdog] Twilio 已更新：$NGROK_URL"
    fi
  fi

  echo "[watchdog] ngrok 已启动"
else
  echo "[watchdog] ngrok 正在运行"
fi
```

添加到 crontab：
```bash
*/2 * * * * NGROK_DOMAIN=your-brain.ngrok.app /path/to/ngrok-watchdog.sh >> /tmp/ngrok-watchdog.log 2>&1
```

### 步骤 5：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/ngrok-tunnel
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"domain":"NGROK_DOMAIN","tier":"hobby"}}' >> ~/.gbrain/integrations/ngrok-tunnel/heartbeat.jsonl
```

## 连接 AI 客户端（tunnel 运行后）

**Claude Code：**
```bash
   claude mcp add gbrain -t http https://your-brain.ngrok.app/mcp \
     -H "Authorization: Bearer YOUR_GBRAIN_TOKEN"
   ```

**Claude Desktop：**
转到设置 > 集成 > 添加。输入：
`https://your-brain.ngrok.app/mcp`

重要提示：Claude Desktop **不**支持通过 JSON 配置远程 MCP。
您**必须**在 GUI 中使用设置 > 集成。这是 #1 设置失败原因。

**Perplexity Computer：**
设置 > 连接器 > 添加远程 MCP。
URL：`https://your-brain.ngrok.app/mcp`

## 实施指南

### Watchdog 模式（来自生产）

```
watchdog():
  // 检查：ngrok 正在运行吗？
  if not process_running("ngrok.*http"):
    start_ngrok()
    sleep(5)

    // 如果没有固定域名，必须更新 Twilio
    if no_fixed_domain AND twilio_configured:
      new_url = get_ngrok_url()  // 来自 localhost:4040/api/tunnels
      update_twilio_webhook(new_url + "/voice")

  // 检查：ngrok 后面的服务正在运行吗？
  if not curl_succeeds("http://localhost:PORT/health"):
    restart_service()
```

### ngrok 检查仪表板

`http://localhost:4040` 显示通过 tunnel 流动的所有请求。使用此功能
调试 MCP 连接问题（请参阅请求/响应头、延迟、错误）。

## 棘手的地方

1. **Claude Desktop 需要 GUI 设置。** 通过
   `claude_desktop_config.json` 添加远程 MCP 服务器**不**工作。它静默失败，没有错误。
   您**必须**使用设置 > 集成。

2. **免费层 URL 是短暂的。** 它们在每次 ngrok 重启时都会更改。
   watchdog 处理 Twilio，但 Claude Desktop 和 Perplexity 必须手动
   重新配置。这就是为什么 Hobby（$8/月）值得。

3. **一个域名，多个服务。** Hobby 提供 1 个免费域名。通过路径
   路由（`/mcp`、`/voice`）在一个域名上，或者每月支付 $8 以获得第二个域名。

4. **Watchdog 必须在启动时运行。** 如果机器重新启动，ngrok 不会
   自动启动，除非您有 watchdog cron 或 systemd 服务。

## 如何验证

1. 启动 tunnel。在浏览器中访问 `https://your-brain.ngrok.app`。
   您应该看到响应（健康检查或默认页面）。
2. 从 Claude Desktop，运行 `gbrain search "test"`。应返回结果。
3. 终止 ngrok。等待 2 分钟。检查 watchdog 是否重新启动它。
4. 从不同的设备（电话），访问相同的 URL。验证它可以工作。

## 成本估算

| 组件 | 月成本 |
|-----------|-------------|
| ngrok 免费 | $0（短暂 URL，重启时更改） |
| ngrok Hobby | $8/月（1 个固定域名，足以满足 MCP + 语音） |
| ngrok Pro | $20/月（2+ 个域名，IP 限制） |
| **推荐** | **$8/月（Hobby）** |

---
*GBrain Skillpack 的一部分。另请参阅：[Voice-to-Brain](twilio-voice-brain.md)、[Remote MCP Deployment](../docs/mcp/DEPLOY.md)*
