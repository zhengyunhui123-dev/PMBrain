---
id: email-to-brain
name: Email-to-Brain
version: 0.7.0
description: Gmail 消息流入大脑页面。确定性收集器提取电子邮件，代理分析并丰富实体。
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor 网关 URL（选项 A — 推荐，为您处理 OAuth）
    where: https://clawvisor.com — 创建一个代理，激活 Gmail 服务
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor 代理令牌（选项 A）
    where: https://clawvisor.com — 代理设置，复制代理令牌
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 客户端 ID（选项 B — 直接 Gmail API 访问）
    where: https://console.cloud.google.com/apis/credentials — 创建 OAuth 2.0 客户端 ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 客户端密钥（选项 B）
    where: https://console.cloud.google.com/apis/credentials — 与客户端 ID 同一页面
health_checks:
  - type: any_of
    label: "认证提供者"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
setup_time: 20 min
cost_estimate: "$0（两个选项都是免费的）"
---

# Email-to-Brain：更新您大脑的 Gmail 消息

电子邮件到达。大脑页面变得更智能。代理读取您的收件箱，检测
实体，更新人员和公司页面，提取操作项，并
使用来源归属归档所有内容。

## 重要：给代理的说明

**您是安装程序。** 请精确按照这些步骤操作。

**核心模式：代码用于数据，LLM 用于判断。**
电子邮件收集分为两层：
1. 确定性：代码提取电子邮件，生成 Gmail 链接，检测噪音/签名。
   这永远不会失败。链接始终是正确的。时间戳始终准确。
2. 潜在：您（代理）读取收集的电子邮件并做出判断。
   谁很重要？提到了哪些实体？存在哪些操作项？

**不要尝试自己提取电子邮件。** 使用收集器脚本。它处理
分页、去重、Gmail 链接生成和噪音过滤。如果您
尝试通过原始 API 调用执行此操作，您**将**忘记链接、错过电子邮件或破坏
分页。收集器存在是因为 LLM 在此方面一直失败。

**为什么顺序执行很重要：**
- 步骤 1 验证凭证网关。没有它，什么都无法连接到 Gmail。
- 步骤 2 设置收集器。没有它，您没有要分析的数据。
- 步骤 3 进行首次收集。没有数据，步骤 4 无法丰富。
- 步骤 4 是**您的工作**：读取摘要，更新大脑页面。

## 架构

```
Gmail 账户
  ↓（ClawVisor E2E 加密网关）
Email Collector（确定性 Node.js 脚本）
  ↓ 输出：
  ├── messages/{YYYY-MM-DD}.json     （结构化电子邮件数据）
  ├── digests/{YYYY-MM-DD}.md        （供代理使用的 markdown 摘要）
  └── state.json                     （分页状态、已知 ID）
  ↓
Agent 读取摘要
  ↓ 判断调用：
  ├── 实体检测（人员、提到的公司）
  ├── 大脑页面更新（时间线条目、编译的真相）
  ├── 操作项提取
  └── 优先级分类（紧急 / 正常 / 噪音）
```

## 固执己见的默认设置

**噪音过滤（确定性，在收集器中）：**
- 跳过：noreply@、notifications@、calendar-notification@
- 标记：DocuSign、Dropbox Sign、HelloSign、PandaDoc（需要操作的签名）
- 保留：其他所有内容

**电子邮件账户：** 配置多个账户。常见设置：
- 工作电子邮件（公司域名）
- 个人电子邮件（gmail.com）

**摘要格式：** 带有部分的每日 markdown：
- 待处理签名（等需要操作的 DocuSign 等）
- 待分类消息（来自真实人员的真实电子邮件）
- 噪音（已过滤，如果需要则可用）

每封电子邮件都获得一个内置的 Gmail 链接：`[在 Gmail 中打开](https://mail.google.com/mail/u/?authuser=ACCOUNT#inbox/MESSAGE_ID)` —— 这些由代码生成，从不是由 LLM 生成，因此它们始终是正确的。

## 先决条件

1. **GBrain 已安装并配置**（`gbrain doctor` 通过）
2. **Node.js 18+**（用于收集器脚本）
3. **通过以下之一访问 Gmail：**
   - ClawVisor（推荐：E2E 加密凭证网关）
   - Google OAuth 凭证（直接 API 访问）
   - Hermes Gateway（内置 Gmail 连接器）

## 设置流程

### 步骤 1：验证凭证网关

询问用户："您如何以编程方式访问 Gmail？选项：
1. ClawVisor（推荐，处理 OAuth 和加密）
2. Google OAuth 凭证（您自己管理令牌）
3. Hermes Gateway（如果您使用 Hermes Agent）"

#### 选项 A：ClawVisor（推荐）

告诉用户：
"我需要您的 ClawVisor URL 和代理令牌。
1. 转到 https://clawvisor.com
2. 创建一个代理（或使用现有的）
3. 激活 Gmail 服务
4. 创建一个目的为：'完全执行助理电子邮件管理
   包括收件箱分类、按任何条件搜索、读取电子邮件、跟踪对话'
   重要提示：任务目的要**宽泛**。诸如 'email triage' 之类的
   狭窄目的将导致合法请求验证失败。
5. 复制网关 URL 和代理令牌"

验证：
```bash
curl -sf "$CLAWVISOR_URL/health" && echo "通过：ClawVisor 可达" || echo "失败"
```

**停止直到 ClawVisor 验证通过。**

#### 选项 B：Google OAuth2 直接

告诉用户：
"我需要用于 Gmail 访问的 Google OAuth2 凭证。具体操作如下：

1. 转到 https://console.cloud.google.com/apis/credentials
   （如果您没有 Google Cloud 项目，请创建一个）
2. 点击 **'+ CREATE CREDENTIALS'** > **'OAuth client ID'**
3. 如果提示，配置 OAuth 同意屏幕：
   - 用户类型：**外部**（或者内部用于 Google Workspace）
   - 应用名称：'GBrain Email'（任何名称都可以）
   - 范围：添加 **'Gmail API .../auth/gmail.readonly'**
   - 测试用户：添加您自己的电子邮件地址
4. 创建 OAuth 客户端 ID：
   - 应用程序类型：**桌面应用**
   - 名称：'GBrain'
5. 复制**客户端 ID** 和**客户端密钥**
6. 还要启用 Gmail API：
   转到 https://console.cloud.google.com/apis/library/gmail.googleapis.com
   点击 **'启用'**"

验证：
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "通过：Google OAuth 凭证已设置" \
  || echo "失败：缺少 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET"
```

然后运行 OAuth 流程以获取令牌：
```bash
# 收集器脚本处理 OAuth 流程：
# 1. 打开浏览器到具有 gmail.readonly 范围的 Google 同意 URL
# 2. 用户授予访问权限
# 3. 脚本接收授权代码，交换为访问 + 刷新令牌
# 4. 将令牌存储在 ~/.gbrain/google-tokens.json 中
# 5. 到期时自动刷新
```

**停止直到 OAuth 流程完成并且令牌已存储。**

### 步骤 2：设置电子邮件收集器

创建收集器目录和脚本：

```bash
mkdir -p email-collector/data/{messages,digests}
cd email-collector
npm init -y
```

收集器脚本需要这些功能：
1. **collect** —— 通过凭证网关从 Gmail 提取电子邮件，按消息 ID 去重，存储为内置 Gmail 链接的 JSON
2. **digest** —— 从收集的电子邮件生成 markdown 摘要，按以下分组：待处理签名、待分类消息、噪音
3. **状态跟踪** —— 记住最后一次收集时间戳和已知消息 ID 以避免重新处理

收集器的关键设计规则：
- Gmail 链接由**代码**生成，而不是由 LLM 生成。格式：`[在 Gmail 中打开](https://mail.google.com/mail/u/?authuser=ACCOUNT#inbox/MESSAGE_ID)`
- 噪音过滤是确定性的：noreply、通知、日历邀请
- 签名检测使用已知模式：DocuSign envelope、Dropbox Sign、HelloSign、PandaDoc
- 所有状态都持久化到 `data/state.json`（最后一次收集时间戳、已知消息 ID）
- 输出是结构化 JSON（机器可读）和 markdown 摘要（代理可读）

### 步骤 3：运行首次收集

```bash
node email-collector.mjs collect
node email-collector.mjs digest
```

验证：`ls data/digests/` 应显示今天的摘要文件。
读取摘要。确认它包含带有可用 Gmail 链接的真实电子邮件。

### 步骤 4：丰富大脑页面

这是**您的工作**（代理）。读取摘要。对于每封电子邮件：

1. **检测实体**：谁发送的？提到了谁？哪些公司？
2. **检查大脑**：`gbrain search "sender name"` —— 我们有页面吗？
3. **更新大脑页面**：如果发送者有一个大脑页面，附加一个时间线条目：
   `- YYYY-MM-DD | 来自 {发送者} 的电子邮件：{主题} [来源：Gmail，{日期}]`
4. **创建新页面**：如果发送者显着且没有页面，创建一个
5. **提取操作项**：如果电子邮件需要回复或操作，记录它
6. **同步**：运行 `gbrain sync --no-pull --no-embed` 以索引更改

### 步骤 5：设置 Cron

收集器应每 30 分钟运行一次：

```bash
*/30 * * * * cd /path/to/email-collector && node email-collector.mjs collect && node email-collector.mjs digest
```

代理应按计划读取摘要（例如，每天 3 次：上午 9 点、下午 12 点、下午 3 点）
并运行步骤 4 中的丰富流程。

### 步骤 6：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/email-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok"}' >> ~/.gbrain/integrations/email-to-brain/heartbeat.jsonl
```

## 实施指南

这些是经过生产测试的模式。精确遵循它们。

### 噪音过滤（确定性）

```
NOISE_SENDERS = ['noreply', 'no-reply', 'notifications@', 'calendar-notification',
                 'mailer-daemon', 'postmaster', 'donotreply']

is_noise(email):
  from = email.from.toLowerCase()
  return NOISE_SENDERS.some(p => from.includes(p))  // 子字符串匹配
```

简单的子字符串匹配，而不是正则表达式。`notifications@slack.com` 匹配因为
`notifications@` 在模式列表中。顺序无关紧要。

### 签名检测

```
SIGNATURE_PATTERNS = [
  /docusign/i, /dropbox sign/i, /hellosign/i, /pandadoc/i,
  /please sign/i, /signature needed/i, /ready for your signature/i,
  /everyone has signed/i, /you just signed/i
]

is_signature(email):
  subject = email.subject || ''
  from = email.from || ''
  return SIGNATURE_PATTERNS.some(p => p.test(subject) || p.test(from))
```

测试**主题和发件人**。签名请求来自
在发件人地址中具有 "docusign" 的服务，而不仅仅是主题。

### Gmail 链接生成（关键）

```
gmail_link(messageId, authuser):
  return `https://mail.google.com/mail/u/?authuser=${authuser}#inbox/${messageId}`
```

`authuser` 参数**至关重要**。没有它，链接将在默认
Gmail 账户中打开，而不是正确的账户。每个电子邮件记录单独存储其账户。
在**代码中**生成这些，从不是由 LLM 生成。链接必须 100% 可靠。

### 去重

```
collect():
  state = load_state()
  since = state.lastCollect ? `newer_than:${hours_since}h` : 'newer_than:1d'

  for account in accounts:
    inbox = gmail.list(query=since, max=50)
    for msg in inbox:
      if msg.id in state.knownMessageIds: continue  // 已看到
      record = build_record(msg)
      state.knownMessageIds[msg.id] = record

    // 还要提取已发送的邮件以检测回复
    sent = gmail.list(query=`from:${account.email} ${since}`, max=30)
    for msg in sent:
      state.knownMessageIds[msg.id] = {is_sent: true}
```

**为什么已发送的邮件很重要：** 没有它，摘要显示"等待回复"
在您已经回复的对话上。已发送的邮件充当负面过滤器。

### 设置后代理应测试的内容

1. **噪音过滤：** 从 `noreply@test.com` 发送测试电子邮件。运行收集。
   验证它出现在噪音部分，而不是分类部分。
2. **Gmail 链接：** 从摘要中点击链接。验证它打开了正确的
   账户（不是默认账户）。
3. **去重：** 在 1 分钟内运行收集两次。验证没有重复的消息。
4. **已发送的邮件：** 手动回复电子邮件。运行收集。验证对话
   在摘要中标记为已回复。

## 成本估算

| 组件 | 月成本 |
|-----------|-------------|
| ClawVisor（免费层） | $0 |
| Gmail API | $0（在免费配额内） |
| **总计** | **$0** |

## 故障排除

**未收集电子邮件：**
- 检查 ClawVisor 运行状况：`curl $CLAWVISOR_URL/health`
- 检查常设任务是否处于活动状态并且已启用 Gmail 服务
- 检查任务目的是否足够宽泛（窄目的阻止请求）

**Gmail 链接不起作用：**
- 验证 `authuser` 参数与账户电子邮件匹配
- Gmail 链接需要登录到正确的 Google 账户

**摘要为空但收集已运行：**
- 检查 `data/messages/` 中是否有 JSON 文件
- 所有电子邮件可能都被过滤为噪音 —— 检查噪音过滤规则

---
*GBrain Skillpack 的一部分。另请参阅：[Credential Gateway](credential-gateway.md)、[Calendar-to-Brain](calendar-to-brain.md)*
