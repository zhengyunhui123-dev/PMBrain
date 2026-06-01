---
id: twilio-voice-brain
name: Voice-to-Brain（已弃用 — 请参阅 agent-voice）
version: 0.8.2
description: "在 v0.40.0.0 中已弃用。新安装使用 `gbrain integrations install agent-voice` — 具有 WebRTC 优先浏览器客户端 + Mars/Venus 角色 + 只读工具路由器的 copy-into-host-repo 范式。此配方保留一个版本作为重定向；将在 v0.41 中移除。"
category: sense
requires: [ngrok-tunnel]
secrets:
  - name: TWILIO_ACCOUNT_SID
    description: Twilio 账户 SID（以 AC 开头）
    where: https://www.twilio.com/console — 登录后主仪表板可见
  - name: TWILIO_AUTH_TOKEN
    description: Twilio 认证令牌（点击仪表板上 SID 旁边的"显示"）
    where: https://www.twilio.com/console — 主仪表板上 Auth Token 下的"显示"
  - name: OPENAI_API_KEY
    description: OpenAI API 密钥（需要账户启用 Realtime API 访问）
    where: https://platform.openai.com/api-keys — 点击"+ Create new secret key"，立即复制（无法再次查看）
health_checks:
  - type: http
    url: "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json"
    auth: basic
    auth_user: "$TWILIO_ACCOUNT_SID"
    auth_pass: "$TWILIO_AUTH_TOKEN"
    label: "Twilio API"
  - type: http
    url: "https://api.openai.com/v1/models"
    auth: bearer
    auth_token: "$OPENAI_API_KEY"
    label: "OpenAI API"
setup_time: 30 min
cost_estimate: "$15-25/月（Twilio 号码 $1-2 + 语音 $0.01/分钟，OpenAI Realtime $0.06/分钟输入 + $0.24/分钟输出）"
---

# Voice-to-Brain：创建大脑页面的电话呼叫

> **⚠️ 自 v0.40.0.0 起已弃用。** 新安装应使用 [agent-voice](agent-voice.md)
> 配方 — 具有 WebRTC 优先语音代理、Mars + Venus 角色、copy-into-host-repo
> 安装范式和只读工具路由器。此配方保留一个版本作为
> 具有现有 Twilio 安装的运营商的重定向。它将在 v0.41 中移除。
>
> **迁移：** `gbrain integrations install agent-voice --target <your-repo>` 将
> 工作参考复制到您的主机代理仓库中，您可以在其中拥有编辑权限。新配方
> 在 `code/lib/twilio-bridge.mjs` 中包含 Twilio 桥接器，适用于仍想要
> 电话接入的运营商，但 WebRTC `/call?test=1` 流程是主打体验。

拨打电话号码。通话。将出现一个结构化的大脑页面，包含实体检测、
交叉引用和发布到您的消息应用程序的摘要。

## 重要提示：给代理的说明

**您是安装程序。** 此配方是为**您（AI 代理）**编写的，代表用户执行。
请精确按照这些说明操作。

**为什么顺序执行很重要：** 每个步骤都依赖于前一个步骤：
- 步骤 1 验证先决条件。如果 GBrain 未配置，其他所有操作都将失败。
- 步骤 2 收集凭证。如果某个凭证错误，步骤 5-7 将静默失败。
- 步骤 3 创建 ngrok tunnel。步骤 5 需要 ngrok URL 用于 Twilio webhook。
- 步骤 5 配置 Twilio。步骤 7（冒烟测试）需要配置 Twilio 才能访问您的服务器。

**不要跳过步骤。不要重新排序步骤。不要批处理多个步骤。**

**停止点（在继续之前必须暂停并验证）：**
- 步骤 1 后：所有先决条件都通过了吗？如果没有，请在继续之前修复。
- 步骤 2 中每个凭证后：验证通过了吗？如果没有，请帮助用户修复。
- 步骤 6 后：健康检查通过了吗？如果没有，请在冒烟测试之前进行调试。
- 步骤 7 后：创建大脑页面了吗？如果没有，请在声明成功之前进行故障排除。

**当某些事情失败时：** 准确地告诉用户什么失败了、这意味着什么以及尝试什么。
永远不要说"出了点问题"。要说"Twilio 返回了 401，这意味着
认证令牌不正确。让我们重新输入。"

## 架构

两个管道选项：

### 选项 A：OpenAI Realtime（交钥匙，更简单）
```
呼叫者（电话）
  ↓ Twilio（WebSocket，g711_ulaw 音频 — 无转码）
Voice Server（Node.js，您的机器或云）
  ↓↑ OpenAI Realtime API（STT + LLM + TTS 在一个管道中）
  ↓ 通话期间的 Function 调用
GBrain MCP（语义搜索、页面读取、页面写入）
  ↓ 通话后
大脑页面已创建（meetings/YYYY-MM-DD-call-{caller}.md）
摘要发布到消息应用程序（Telegram/Slack/Discord）
```

### 选项 B：DIY STT+LLM+TTS（完全控制，生产级）
```
呼叫者（电话或 WebRTC 浏览器）
  ↓ Twilio WebSocket 或 WebRTC
Voice Server（Node.js）
  ↓ Deepgram STT（流式语音转文本，说话者 diarization）
  ↓ Claude API（流式 SSE，句子边界调度）
  ↓ Cartesia / OpenAI TTS（文本转语音，低延迟）
  ↓ 通话期间的 Function 调用
GBrain MCP（语义搜索、页面读取、页面写入）
  ↓ 通话后
大脑页面 + 音频上传 + 转录存储
```

**为什么选择 v2（选项 B）？** OpenAI Realtime 是一个黑盒 — 您无法控制 STT
质量、交换 LLM 或调试音频问题。DIY 堆栈为您提供透明的
Deepgram+Claude+TTS，完全控制每个阶段。权衡：更多的集成
工作，但您拥有管道。

**生产测试的 v2 架构（pipeline.mjs，约 250 行）：**
- 来自 Claude 的流式 SSE，具有句子边界 TTS 调度
- 20 轮对话历史上限（防止上下文膨胀）
- STT/TTS 断开时的重新连接逻辑，具有指数退避
- 定期保持活动以防止 WebSocket 超时
- 音频端点检测以实现自然的说话轮流
- 智能 VAD（Silero）作为默认，带有 push-to-talk 回退

## 固执己见的默认设置

这些是从真实部署中产生的生产测试默认设置。设置后自定义。

**呼叫者路由（基于提示，强制执行服务器端）：**
- 所有者：通过安全通道进行 OTP 质询，然后完全访问（读取 + 写入 + 网关）
- 受信任的联系人：回拨验证，范围写入访问
- 已知联系人（大脑分数 >= 4）：按名称热情问候，提供转接
- 未知呼叫者：筛选，询问姓名 + 原因，留言

**安全：**
- Twilio 签名验证在 `/voice` 端点（`X-Twilio-Signature` 头）
- 未认证的呼叫者永远不会看到写入工具
- 呼叫者 ID **不** 被信任用于认证（需要 OTP 或回拨）

---

## 设置流程

### 步骤 1：检查先决条件

**如果任何检查失败，请停止。在继续之前修复。**

运行这些检查并向用户报告结果：

```bash
# 1. 验证 GBrain 已配置
gbrain doctor --json
```
如果失败："GBrain 尚未设置。让我们先运行 `gbrain init --supabase`。"

```bash
# 2. 验证 Node.js 18+
node --version
```
如果缺少或 < 18："需要 Node.js 18+。安装：https://nodejs.org/en/download"

```bash
# 3. 检查 ngrok 是否已安装
which ngrok
```
如果缺少：
- **Mac：** "在终端中运行 `brew install ngrok`。"
- **Linux：** "运行 `snap install ngrok` 或从 https://ngrok.com/download 下载"

告诉用户："所有先决条件已检查。[N/3 通过]。[列出任何失败以及如何修复。]"

### 步骤 2：收集和验证凭证

**一次询问一个凭证。立即验证。在
当前凭证验证通过之前，不要继续
下一个凭证。**

**凭证 1：Twilio 账户 SID + 认证令牌**

告诉用户：
"我需要您的 Twilio 账户 SID 和认证令牌。具体操作如下：

1. 转到 https://www.twilio.com/console（如果您没有账户，请免费注册）
2. 登录后，您将在主仪表板上看到您的 **账户 SID**
   （它以 'AC' 开头，后跟 32 个字符）
3. 在它下面，您将看到 **认证令牌** — 点击 **'显示'** 以显示它
4. 复制两个值并粘贴给我"

用户提供后，立即验证：

```bash
curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json" \
  | grep -q '"status"' \
  && echo "通过：Twilio 凭证有效" \
  || echo "失败：Twilio 凭证无效 — 仔细检查 SID 以 'AC' 开头且认证令牌正确"
```

**如果验证失败：** "那没用。常见问题：（1）SID 应以 'AC' 开头，（2）确保您点击了'显示'以显示认证令牌并复制了
完整值，（3）如果您刚刚创建了账户，请等待 30 秒并重试。"

**在此停止，直到 Twilio 验证通过。**

**凭证 2：OpenAI API 密钥**

告诉用户：
"我需要您的 OpenAI API 密钥。具体操作如下：

1. 转到 https://platform.openai.com/api-keys
2. 点击 **'+ Create new secret key'**（右上角）
3. 将其命名为 'gbrain-voice' 之类的名称
4. 点击 **'Create secret key'**
5. **立即复制密钥** — 关闭对话框后，您将**无法**再次看到它
6. 粘贴给我

注意：您的 OpenAI 账户需要 Realtime API 访问权限。大多数账户默认拥有它。"

用户提供后，立即验证：

```bash
curl -sf -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models > /dev/null \
  && echo "通过：OpenAI 密钥有效" \
  || echo "失败：OpenAI 密钥无效 — 确保复制了完整密钥（以 sk- 开头）"
```

**如果验证失败：** "那没用。常见问题：（1）密钥以 'sk-' 开头，（2）确保复制了整个密钥（它很长），（3）如果您刚刚创建了
它，它会立即激活 — 无需延迟。"

**在此停止，直到 OpenAI 验证通过。**

**凭证 3：ngrok 账户（推荐 Hobby 层）**

告诉用户：
"我需要您的 ngrok 认证令牌。**我强烈推荐 Hobby 层（$8/月）**，
因为它为您提供了一个永不更改的固定域名。使用免费层，
您的 URL 在每次 ngrok 重启时都会更改，破坏 Twilio 和 Claude Desktop。

1. 转到 https://dashboard.ngrok.com/signup（注册）
2. **推荐：** 转到 https://dashboard.ngrok.com/billing 并升级到
   **Hobby**（$8/月）。这为您提供了一个固定域名。
3. 如果您升级了：转到 https://dashboard.ngrok.com/domains 并点击
   **'+ New Domain'**。选择一个名称（例如，`your-brain-voice.ngrok.app`）。
4. 转到 https://dashboard.ngrok.com/get-started/your-authtoken
5. 复制您的 **认证令牌** 并粘贴给我
6. 还要告诉我您的固定域名（如果您创建了一个）"

```bash
ngrok config add-authtoken $NGROK_TOKEN \
  && echo "通过：ngrok 已配置" \
  || echo "失败：ngrok 认证令牌被拒绝"
```

如果用户有固定域名，请使用 `--url` 标志（下面的步骤 3）。
如果用户停留在免费层，URL 将在重启时更改（watchdog 处理此问题）。

**凭证 4：消息平台（用于通话摘要）**

询问用户："我应该将通话摘要发送到哪里？选项：Telegram、Slack 或 Discord。"

根据他们的选择：
- **Telegram：** "通过 Telegram 上的 @BotFather 创建机器人，复制机器人令牌，并
  告诉我要将摘要发送到哪个聊天/群组。"
  验证：`curl -sf "https://api.telegram.org/bot$TOKEN/getMe" | grep -q '"ok":true'`
- **Slack：** "在 https://api.slack.com/apps → 您的应用 →
  Incoming Webhooks → 添加新。复制 webhook URL。"
  验证：`curl -sf -X POST -d '{"text":"GBrain voice test"}' $WEBHOOK_URL`
- **Discord：** "转到您的服务器 → 频道设置 → 集成 → Webhooks →
  新建 Webhook。复制 webhook URL。"
  验证：`curl -sf -X POST -H "Content-Type: application/json" -d '{"content":"GBrain voice test"}' $WEBHOOK_URL`

告诉用户："所有凭证已验证。正在转到服务器设置。"

### 步骤 3：启动 ngrok Tunnel

```bash
# 使用固定域名（Hobby 层 — 推荐）：
ngrok http 8765 --url your-brain-voice.ngrok.app

# 不使用固定域名（免费层 — URL 在重启时更改）：
ngrok http 8765
```

如果使用固定域名，URL 始终为 `https://your-brain-voice.ngrok.app`。
如果使用免费层，请从 ngrok 输出中复制 URL（每次重启都会更改）。

注意：ngrok 在前台运行。在后台进程或新终端标签中运行它。

同一个 ngrok 账户还可以为您的 GBrain MCP 服务器提供服务（请参阅
[ngrok-tunnel 配方](recipes/ngrok-tunnel.md) 以获取完整的多服务模式）。

### 步骤 4：创建语音服务器

创建语音服务器目录并安装依赖项：

```bash
mkdir -p voice-agent && cd voice-agent
npm init -y
npm install ws express
```

语音服务器需要在 `server.mjs` 中包含以下组件：

1. **HTTP 服务器** 在端口 8765 上，具有：
   - `POST /voice` — 返回打开 WebSocket 媒体流到 `/ws` 的 TwiML
   - `GET /health` — 返回 `{ ok: true }`
   - Twilio 签名验证（`X-Twilio-Signature` 头）在 `/voice` 上

2. **WebSocket 处理程序** 在 `/ws` 上，它：
   - 接受 Twilio 媒体流（g711_ulaw 音频）
   - 打开第二个 WebSocket 到 `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`
   - 双向桥接音频（无转码 — 双方都使用 g711_ulaw）
   - 处理来自 OpenAI 的 `response.function_call_arguments.done` 事件（工具执行）
   - 通过 `conversation.item.create` 发送工具结果，类型为 `function_call_output`

3. **系统提示构建器**，它接收呼叫者电话号码并返回：
   - 基于呼叫者路由规则的适当问候语
   - 可用工具（未认证的为只读，已认证的为完整）
   - 指令："您是语音助手。在回答问题之前搜索大脑。
     从未知呼叫者获取消息。永远不要先挂断。"

4. **工具执行器**，它：
   - 生成 GBrain MCP 客户端（`gbrain serve` 作为 stdio 子进程）
   - 路由功能调用：`search_brain` → `gbrain query`，`lookup_person` → `gbrain search` + `gbrain get`
   - 在认证后面控制写入工具

5. **通话后处理程序**，它：
   - 将转录保存到 `brain/meetings/YYYY-MM-DD-call-{caller}.md`
   - 将摘要发布到用户的消息平台
   - 运行 `gbrain sync --no-pull --no-embed` 以索引新页面

6. **WebRTC 端点**（可选，用于基于浏览器的呼叫）：
   - `POST /session` — 接受 SDP offer，转发到 OpenAI Realtime `/v1/realtime/calls` 作为 multipart form-data，返回 SDP answer
   - `GET /call` — 提供带有以下内容的 web 客户端 HTML 页面：
     - 到 OpenAI Realtime API 的 WebRTC 连接
     - RNNoise WASM 噪声抑制（AudioWorklet）
     - Push-to-talk 和 auto-VAD 模式切换
     - 管道：麦克风 → RNNoise 去噪 → MediaStream → WebRTC → OpenAI
   - `POST /tool` — 接收来自 WebRTC 数据通道的工具调用，执行它们，返回结果
   - 这允许用户从浏览器标签页而不是电话呼叫语音代理

   **WebRTC 会话创建伪代码：**
   ```
   POST /session:
     sdp = request.body  // 呼叫者的 SDP offer

     sessionConfig = JSON.stringify({
       type: 'realtime',
       model: 'gpt-4o-realtime-preview',
       audio: { output: { voice: VOICE } },
       instructions: buildPrompt(null),
       tools: TOOL_SETS.unauthenticated,
     })

     // 使用原生 FormData（Node 18+）— 不要手动 multipart
     fd = new FormData()
     fd.set('sdp', sdp)
     fd.set('session', sessionConfig)

     response = POST 'https://api.openai.com/v1/realtime/calls'
       Authorization: Bearer OPENAI_API_KEY
       body: fd   // fetch() 自动设置 Content-Type

     return response.text()  // SDP answer
   ```

   **重要的 WebRTC 陷阱：**
   - `voice` 放在 `audio.output.voice` 下，而不是顶级
   - 不要在会话配置中发送 `turn_detection`（不被 `/v1/realtime/calls` 接受）
   - 连接时不要发送 `session.update`（服务器已配置它）
   - 所有 `session.update` 调用必须包含 `type: 'realtime'` 以避免 session.type 错误
   - 通过 WebRTC 数据通道**不**支持 `input_audio_transcription` — 请改为在录制的音频上使用 Whisper post-call
   - 在 WebRTC 连接后通过数据通道触发问候语

**参考实现：** 上面的架构和 OpenAI Realtime API
文档 (https://platform.openai.com/docs/guides/realtime) 提供了构建块。

### 步骤 5：配置 Twilio 电话号码

告诉用户：
"现在我需要设置您的 Twilio 电话号码。具体操作如下：

1. 转到 https://www.twilio.com/console/phone-numbers/search
2. 搜索号码（选择您的区号或任何可用号码）
3. 点击您想要的号码旁边的 **'Buy'**（费用 $1-2/月）
4. 购买后，转到 https://www.twilio.com/console/phone-numbers/incoming
5. 点击您的新号码
6. 滚动到 **'Voice Configuration'**
7. 在 **'A call comes in'** 下，选择 **'Webhook'**
8. 输入：`https://YOUR-NGROK-URL.ngrok-free.app/voice`
9. 方法：**HTTP POST**
10. 点击 **'Save configuration'**
11. 告诉我您购买的电话号码"

或者，如果用户更喜欢 CLI：
```bash
# 购买号码（美国本地）
twilio phone-numbers:buy:local --area-code 415

# 配置 webhook
twilio phone-numbers:update PHONE_SID \
  --voice-url https://YOUR-NGROK-URL.ngrok-free.app/voice \
  --voice-method POST
```

### 步骤 6：启动语音服务器并验证

```bash
cd voice-agent && node server.mjs
```

**停止并验证：**
```bash
curl -sf http://localhost:8765/health && echo "语音服务器：正在运行" || echo "语音服务器：未运行"
```

如果未运行：检查服务器日志以查找错误。常见问题：
- 端口 8765 已在使用中：`lsof -i :8765` 以查找正在使用它的内容
- 缺少环境变量：确保已设置 OPENAI_API_KEY
- 未找到模块：再次运行 `npm install`

### 步骤 7：冒烟测试（出站呼叫）

**这是神奇的时刻。** 代理呼叫**用户**以证明系统正常工作：

告诉用户："您的电话即将响起。接听并交谈约 30 秒。
说类似 '嘿，我正在测试我的新语音到大脑系统。提醒我
明天检查季度数字。' 完成后，挂断。"

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
  --data-urlencode "To=USER_PHONE_NUMBER" \
  --data-urlencode "From=TWILIO_PHONE_NUMBER" \
  --data-urlencode "Url=https://YOUR-NGROK-URL.ngrok-free.app/voice" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

**通话结束后，验证以下所有内容：**

1. 消息通知已到达，带有通话摘要
2. 大脑页面存在：
   ```bash
   gbrain search "call" --limit 1
   ```
3. 大脑页面包含：转录、实体提及、操作项

**如果冒烟测试失败：**
- 无响铃：检查 https://www.twilio.com/console/debugger 中的 Twilio 控制台以查找错误日志
- 响铃但无语音：检查 ngrok tunnel 是否启动，检查 OpenAI 密钥是否有效
- 语音工作但无大脑页面：检查通话后处理程序日志，手动运行 `gbrain sync`
- 有大脑页面但无消息：检查消息机器人令牌是否有效

**在此停止，直到冒烟测试通过。在用户
确认他们收到了消息通知**并且**大脑页面存在之前，不要声明成功。**

### 步骤 8：设置入站呼叫

告诉用户："冒烟测试通过了 — 语音到大脑已上线！您的号码是
[TWILIO_NUMBER]。现在让我们设置入站呼叫。"

1. Twilio webhook 已从步骤 5 配置
2. 询问："您是否希望拨打您的现有电话的呼叫
   在响几声后转发到此号码？这样，如果您可以接听，您就接听，如果您不接听，语音代理
   就会接听。"
3. 在系统提示中配置呼叫者路由规则
4. 将用户的电话号码添加为"所有者"号码以获得完全访问权限

### 步骤 9：Watchdog（自动重启）

```bash
# Cron watchdog（每 2 分钟）— 添加到 crontab
*/2 * * * * curl -sf http://localhost:8765/health > /dev/null || (cd /path/to/voice-agent && node server.mjs >> /tmp/voice-agent.log 2>&1 &)
```

如果使用 ngrok，还要设置 URL 监控（免费 ngrok URL 在重启时更改）：
```bash
# 检查 ngrok URL 是否已更改，如果已更改则更新 Twilio
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"https://[^"]*' | grep -o 'https://.*')
if [ -n "$NGROK_URL" ]; then
  twilio phone-numbers:update PHONE_SID --voice-url "$NGROK_URL/voice"
fi
```

### 步骤 10：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/twilio-voice-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.8.1","status":"ok","details":{"phone":"TWILIO_NUMBER","deployment":"local+ngrok"}}' >> ~/.gbrain/integrations/twilio-voice-brain/heartbeat.jsonl
```

告诉用户："语音到大脑已完全设置。您的号码是 [NUMBER]。以下是
现在发生的情况：任何呼叫的人都会由语音代理筛选。已知联系人
获得热情的问候。未知呼叫者留言。每次通话都会创建一个大脑
页面，包含完整的转录，并且您会在 [他们的消息平台] 上获得摘要。
Watchdog 会在服务器崩溃时重新启动它。"

## 成本估算

| 组件 | 月成本 | 来源 |
|-----------|-------------|--------|
| Twilio 电话号码 | $1-2/月 | [Twilio 定价](https://www.twilio.com/en-us/voice/pricing) |
| Twilio 语音分钟数（100 分钟） | $1-2/月 | 取决于方向的 $0.0085-0.015/分钟 |
| OpenAI Realtime 输入（100 分钟） | $6/月 | [$0.06/分钟](https://openai.com/api/pricing/) |
| OpenAI Realtime 输出（50 分钟） | $12/月 | [$0.24/分钟](https://openai.com/api/pricing/) |
| ngrok（免费层） | $0 | 静态域名：$8/月 |
| **总计估计** | **$20-22/月** | 约 100 分钟通话 |

## 故障排除

**呼叫无法连接：**
- 检查 ngrok：`curl http://localhost:4040/api/tunnels` — 如果为空，ngrok 未运行
- 检查语音服务器：`curl http://localhost:8765/health` — 应返回 `{"ok":true}`
- 检查 Twilio 调试器：https://www.twilio.com/console/debugger — 显示 webhook 错误
- 检查 webhook URL：转到 https://www.twilio.com/console/phone-numbers/incoming，点击您的号码，验证 webhook URL 与您的 ngrok URL 匹配

**语音代理无响应：**
- 检查 OpenAI 密钥：步骤 2 的验证命令仍应通过
- 检查服务器日志中是否有 WebSocket 错误（查找"connection refused"或"401"）
- 验证 Realtime API 访问权限：并非所有 OpenAI 账户都有它。检查 https://platform.openai.com/docs/guides/realtime

**通话后未创建大脑页面：**
- 运行 `gbrain doctor` — 如果失败，则数据库连接已断开
- 检查通话后处理程序是否已运行（在服务器日志中查找"transcript saved"）
- 手动运行 `gbrain sync` 以强制索引
- 检查大脑仓库目录上的文件权限

**ngrok URL 不断更改：**
- 免费的 ngrok URL 在每次 ngrok 重启时都会更改
- Watchdog（步骤 9）自动处理此问题
- 对于永久 URL：升级到 ngrok 付费（$8/月）以获得静态域名，或部署到 Fly.io/Railway 代替

**注意：选项 B 凭证：** 如果您使用 DIY 管道（选项 B），您还将
需要您选择的 STT 提供商（例如，Deepgram）和 TTS 提供商
（例如，Cartesia、OpenAI TTS）的 API 密钥。在步骤 2 期间收集并验证这些，
以及上面列出的 Twilio 和 OpenAI 凭证。

## 关键生产修复（v0.8.1）

这些**不是**可选的。它们可以防止在
处理日常呼叫的部署中发现的真实生产故障。

### Unicode 崩溃修复（关键）

**问题：** 提示上下文中的破折号（--）、箭头（->）和其他非 ASCII 字符
导致损坏的代理对，从而崩溃 Twilio WebSocket
连接。电话呼叫静默断开。

**修复：** 在发送到 Twilio 之前，替换整个
提示文件中的所有非 ASCII 字符为 ASCII 等效项。这在开发中是不可见的
（浏览器可以很好地处理 unicode），但在生产中却是灾难性的。

```javascript
function sanitizeForTwilio(text) {
  return text
    .replace(/[\u2014\u2013]/g, '--')   // em/en 破折号
    .replace(/[\u2018\u2019]/g, "'")     // 智能单引号
    .replace(/[\u201C\u201D]/g, '"')     // 智能双引号
    .replace(/\u2192/g, '->')              // 右箭头
    .replace(/\u2190/g, '<-')              // 左箭头
    .replace(/[\u2026]/g, '...')         // 省略号
    .replace(/[^\x00-\x7F]/g, '')        // 剥离剩余的非 ASCII
}
```

### PII 从语音上下文中清除（关键）

**问题：** 加载到语音提示中的大脑上下文可能包含电话号码、
电子邮件地址和其他 PII。语音代理向呼叫者大声朗读这些内容。

**修复：** 在注入提示之前，从所有语音上下文中通过正则表达剥离 PII：
- 电话号码：`/\+?\d[\d\s\-().]{7,}\d/g`
- 电子邮件地址：`/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`
- 带有认证令牌或 API 密钥的 URL
- 匹配常见凭证模式的任何字符串

### 身份优先提示（重要）

**问题：** 语音代理在对话中途失去其身份。说"您不是
Claude"不会保留。模型恢复为其基本角色。

**修复：** 将身份**首先**放在系统提示中，在任何上下文或规则之前：
```
# 您就是 [代理名称]
您是 [名称]，与 [大脑名称] 一起工作的语音助手。
您不是 Claude。您**不是**通用 AI 助手。
[名称] 有自己的个性：[特征]。

# 上下文
[... 大脑上下文、日历、任务 ...]

# 规则
[... 行为规则 ...]
```

将身份定位在上下文之前可确保模型首先看到它并在
整个对话过程中保持它。

### 自动上传通话音频（推荐）

**问题：** 如果通话后处理失败，通话音频将永远丢失。

**修复：** 在通话结束时立即自动上传**所有**通话音频：
- Twilio 通话：从 Twilio 下载 MP3 录制 URL
- WebRTC 通话：通过 MediaRecorder 捕获（webm/opus 格式）
- 通过 `gbrain files upload-raw <audio-file> --page meetings/call-slug --type call-recording` 上传
- GBrain 自动路由：小文件保留在 git 中，大文件转到云存储
  带有 `.redirect.yaml` 指针。文件 >= 100 MB 使用 TUS 可恢复上传。
- 生成用于播放的签名 URL：`gbrain files signed-url <storage-path>`
- 这确保每个通话都有一个可恢复的音频源，无论
  转录或大脑页面是否成功创建

### 智能 VAD 作为默认

**问题：** Push-to-talk 在电话呼叫中不自然。服务器端 VAD 具有
可变的质量。

**修复：** 默认使用智能 VAD（Silero VAD）进行语音活动检测：
- 比服务器端 VAD 更好的端点检测
- 在嘈杂环境中更少的误触发
- PTT 可用作回退（WebRTC 客户端的 UI 切换）
- 预设：安静（0.7 阈值）、正常（0.85）、嘈杂（0.95）、非常嘈杂（0.98）

## 生产模式（推荐）

这些模式来自生产语音部署，每天处理真实呼叫。
它们**不是**基本设置所必需的。**在冒烟测试通过后实施它们。**
每个模式都是独立的且可选的。

### 代理身份与参与

#### 身份分离

**问题：** 假装是完整 AI 系统的语音代理会创建恐怖谷效应。
**模式：** 语音代理选择自己的名称和个性，与主要
AI 大脑不同。"我与 [大脑] 一起工作，[所有者] 的 AI。" 更轻，更俏皮，更好奇。

#### 预计算竞标系统

**问题：** 死气会破坏参与度。语音代理被动等待。
**模式：** 在通话开始时，扫描实时上下文并预计算最多 10 个参与竞标。
两种类型：信息性的（任务、日历、社交监控）和关系性的（好奇心模板）。
竞标进入提示，以便代理从列表中选择。将竞标 #1 和 #2 用于问候语，
在对话期间循环其余的。永远不要问"还有什么吗？" —— 提出下一个竞标。

#### 上下文优先提示

**问题：** 语音代理通用问候，因为它不知道今天发生了什么。
**模式：** 在通话开始时加载实时上下文：任务、日历、位置、社交监控、
晨间简报。将上下文**首先**放置在提示中（在规则之前），以便模型立即看到
它并在问候语中使用它。每个部分使用 try/catch。每个部分限制 500-1000 个字符。

#### 主动顾问模式

**问题：** 语音代理是被动的任务机器。
**模式：** 代理驱动对话。预测陈旧任务上的决策。
建议利用趋势项目。将即将发生的事件与大脑上下文联系起来。
"死气是您的敌人" — 填补每个暂停。永远不要被动等待。

#### 对话时机（#1 修复）

**问题：** 语音代理在思考中途打断**并且**在呼叫者完成后保持沉默。
两者感觉都很糟糕。早期的"填补每个暂停"指令导致代理在呼叫者
正在思考时与他们交谈。
**模式：** 用细致的时机规则替换笼统的"永远不要沉默"：
- **呼叫者正在说话或思考：** 闭嘴。即使是 3-5 秒的暂停，也要等待。
  不完整的句子或故事中途 = 仍在思考。不要打断。
- **呼叫者已完成**（完整的想法 + 2-3 秒沉默）：**现在**回应。使用竞标，
  提出后续问题，或转到下一个主题。
- **检测启发式：** 不完整的句子 = 仍在思考。完整的陈述 +
  沉默 = 已完成。直接针对您的问题 = 立即回应。
- **硬规则：** 在完整的想法之后，永远不要让沉默超过 5 秒。

将其作为标记部分添加到系统提示中（例如，`# 关键：对话时机`），
突出显示，以便模型尽早看到它。这来自真实的使用反馈，
并且是单一最高影响的语音质量改进。

#### 无重复规则

**问题：** 语音代理在一次通话中多次循环回到同一个竞标。
**模式：** 添加到系统提示中："不要重复自己。如果您已经说过
什么，请转到**下一个**竞标。改变您的回应。" 简单，但解决了真实
烦恼，在较长的通话中会复合。

### 提示工程

#### 激进的提示压缩

**问题：** 长系统提示会增加每个回合的延迟和成本。
**模式：** 激进地压缩。生产从 13K 变为 4.7K 令牌（65% 削减）。
项目符号优于散文，削减重复，行为优先。每个令牌都会花费延迟 + 金钱。

#### OpenAI Realtime 提示结构

**问题：** 散文段落对模型解析缓慢。
**模式：** 使用标记 markdown 部分：`# Role & Objective`、`# Personality & Tone`、
`# Rules`、`# Conversation Flow` 带有状态机子状态（`## State 1: VERIFY`、
`## State 2: GREETING`、`## State 3: CONVERSATION`）、`# Trust`。

#### 语音前的认证

**问题：** 认证流程会在通话开始时增加死气。
**模式：** 在说任何问候语**之前**，调用认证工具。然后说"嘿，代码
即将到来。" 从往返中节省几秒钟。

#### 大脑升级

**问题：** 语音代理无法回答需要完整大脑的复杂问题。
**模式：** 如果呼叫者说"与 [大脑] 交谈"或问一个深层问题，请立即通过网关工具进行路由，
并带有口头桥接："等一下，正在与 [大脑] 核对。"

### 呼叫可靠性

#### 卡住的 Watchdog

**问题：** 当 VAD 失速或工具执行挂起时，通话会静默。
**模式：** 20 秒计时器。如果没有音频输出：清除输入缓冲区，注入"您还在吗？" 系统消息，强制 `response.create`。

#### 永远不要挂断

**问题：** AI 代理尝试结束通话。
**模式：** 硬提示规则：只有呼叫者决定通话何时结束。永远不要说
再见、"我让您去"或总结性语言。如果沉默，问"您还在吗？"

#### 思考声音

**问题：** 缓慢的工具执行期间的死气。
**模式：** 在 JSON 数组中预生成 g711_ulaw 音频块。在缓慢的工具（大脑搜索、web 查找）期间以 20 毫秒间隔循环。
工具结果返回时停止。

#### 回退 TwiML

**问题：** 语音代理崩溃，呼叫者得到沉默。
**模式：** `/fallback` 端点返回 TwiML，转发到所有者的手机。配置为
Twilio 回退 URL。

### 认证与授权

#### 工具集架构

**问题：** 未认证的呼叫者访问写入操作。
**模式：** 四个集合：READ_TOOLS（所有呼叫者）、WRITE_TOOLS（所有者）、SCOPED_WRITE_TOOLS
（受信任的用户）、GATEWAY_TOOLS（已认证）。LLM 在认证
成功之前不会看到写入工具。通过带有新工具数组的 `session.update` 进行升级。
所有 `session.update` 调用必须包含 `type: 'realtime'`。

#### 带有回拨的受信任用户认证

**问题：** 除了所有者之外的人需要认证的访问权限。
**模式：** 电话注册表 + 回拨验证。每个用户获得一个范围：完整、
家庭、内容、运营。范围决定他们访问哪些工具。

#### 呼叫者路由

**问题：** 不同的呼叫者需要不同的体验。
**模式：** `buildPrompt(callerPhone)` 返回不同的系统提示：所有者（OTP）、
受信任的（回拨）、核心圈子（热情的问候 + 转接）、已知的（问候、消息）、
未知的（筛选 + 消息）。

### 语音质量

#### 动态 VAD / 噪声模式

**问题：** 背景噪声会导致误触发或错过语音。
**模式：** `set_noise_mode` 工具在通话中调整 VAD 阈值。预设：安静（0.7）、
正常（0.85）、嘈杂（0.95）、非常嘈杂（0.98）。代理在噪声时主动调用。

#### 屏幕上调试 UI

**问题：** 从电话测试时，console.log 毫无用处。
**模式：** WebRTC 客户端内联显示工具调用、结果、错误和关键事件。

### 实时感知

#### 实时时刻捕获

**问题：** 通话期间说的重要事情会丢失，如果
通话掉线或通话后摘要工具不触发。
**模式：** 当呼叫者分享重要的事情（反馈、想法、个人
故事、决策）时，请使用 `log_voice_request` 工具实时记录它。不要
等到通话结束。告诉呼叫者："知道了，现在将其发送到 [大脑]。"
还将关键时刻流式传输到 [消息平台]，以便在通话结束之前，主要代理
具有感知能力。

####  Belt-and-Suspenders 通话后

**问题：** 通话后处理取决于语音代理记住调用
`post_call_summary` 工具。如果通话掉线或代理忘记，则通话将丢失。
**模式：** 基于**工具**和自动通话结束处理程序都应发布
结构化信号。通话结束处理程序（在 WebSocket 关闭或 `/call-end` 上触发）
应发布到 [消息平台]，其中包含：
- 音频文件路径
- 转录文件路径（或如果没有，则发出警告）
- 通话期间使用的工具
- 明确指令："[大脑]：读取通话，总结，采取行动。"

这确保每个通话都会得到处理，无论语音代理是否
记住调用摘要工具。Belt and suspenders。

### 通话后处理

#### 强制性 3 步通话后

**问题：** 主要代理不知道发生了通话。
**模式：** 每次通话都以三个步骤结束：
1. **消息通知** — 摘要到 [消息平台]
2. **转录到大脑** — `brain/meetings/YYYY-MM-DD-call-{caller}.md`
3. **音频到存储** — Twilio MP3 或 WebRTC webm/opus，上传到云存储

#### WebRTC 音频 + 转录奇偶校验

**问题：** WebRTC 通话不通过 Twilio，无自动日志记录。
**模式：** 客户端捕获音频（MediaRecorder，webm/opus）和转录（每轮
POST 到 `/transcript`）。在通话结束时，POST 到 `/call-end` 保存 JSON 日志。两个通道
产生相同的输出格式。注意：`input_audio_transcription` 不通过 WebRTC 数据通道支持 — 请改为使用 Whisper post-call。

#### 双 API 事件处理

**问题：** OpenAI Realtime API 更改了事件名称。
**模式：** 处理 `response.audio.delta`（旧）和 `response.output_audio.delta`
（新）。与 `.done` 事件相同。面向未来的 API 更改。

### 大脑查询优化

#### 报告感知查询路由

**问题：** 关于特定主题的语音查询会触发缓慢的向量搜索。
**模式：** 在全文大脑搜索**之前**，根据关键词映射检查问题：

| 关键词 | 报告已加载 |
|---------|--------------|
| email、inbox、mail | 收件箱扫描报告 |
| social、twitter、mentions | 社交参与报告 |
| briefing、morning | 晨间简报 |
| meeting | 会议同步报告 |
| slack | slack 扫描报告 |
| content、ideas | 内容创意报告 |

加载最多 2,500 个字符的匹配报告。第一次匹配后中断。如果无关键词匹配，则回退到完整
大脑搜索。
