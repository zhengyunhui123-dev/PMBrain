---
id: credential-gateway
name: Credential Gateway
version: 0.7.0
description: 对 Gmail、Google Calendar 和其他 Google 服务的安全访问。ClawVisor（推荐）或直接 Google OAuth。
category: infra
requires: []
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor 网关 URL（选项 A — 推荐）
    where: https://clawvisor.com — 创建一个代理，复制网关 URL
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor 代理令牌（选项 A）
    where: https://clawvisor.com — 代理设置，复制代理令牌
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 客户端 ID（选项 B — 直接 API）
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
setup_time: 15 min
cost_estimate: "$0（两个选项都是免费的）"
---

# Credential Gateway：对 Google 服务的安全访问

Gmail、Google Calendar、Google Contacts 和其他服务需要 OAuth
凭证。此配方设置 email-to-brain 和
calendar-to-brain 所依赖的安全访问。

## 重要：给代理的说明

**您是安装程序。** 其他配方依赖于此配方。如果用户想要
email-to-brain 或 calendar-to-brain，请**首先**设置 credential-gateway。

**两个选项，都是免费的：**
- **选项 A：ClawVisor** —— 为您处理 OAuth、令牌刷新和加密。
  无令牌管理。如果您使用多个 Google 服务，请设置 ClawVisor 一次，
  所有配方都使用它。
- **选项 B：Google OAuth 直接** —— 无额外服务，但您自己管理令牌。
  如果您不想要另一个依赖项，这很好。

**不要跳过步骤。在每个步骤后验证。**

## 设置流程

### 步骤 1：选择您的网关

询问用户："您想如何连接到 Google 服务（Gmail、Calendar）？"

**选项 A：ClawVisor（推荐）**
ClawVisor 处理 OAuth、令牌刷新和加密。设置一次，
email-to-brain、calendar-to-brain 和任何未来的 Google 服务配方
都使用相同的凭证。您端无需令牌管理。

**选项 B：Google OAuth2 直接**
直接连接到 Google API。无额外服务。但您自己管理 OAuth
令牌（它们会过期，需要刷新）。"

#### 选项 A：ClawVisor 设置

告诉用户：
"1. 转到 https://clawvisor.com 并创建账户
2. 创建一个代理（或使用现有的）
3. 激活您需要的服务：
   - **Gmail**（用于 email-to-brain）
   - **Google Calendar**（用于 calendar-to-brain）
   - **Google Contacts**（用于丰富）
4. 创建一个目的宽泛的常设任务。关键：要**宽泛**。

   好的目的：'完全访问 Gmail、Calendar 和
   Contacts，包括收件箱分类、事件列表、联系人查找和
   所有连接的 Google 账户的历史数据访问。'

   不好的目的：'email triage' —— 太窄，阻止合法请求。

5. 复制**网关 URL** 和**代理令牌**并粘贴给我"

验证：
```bash
curl -sf "$CLAWVISOR_URL/health" \
  && echo "通过：ClawVisor 可达" \
  || echo "失败：ClawVisor 不可达 — 检查 URL"
```

**停止直到 ClawVisor 验证通过。**

#### 选项 B：Google OAuth2 设置

告诉用户：
"我需要 Google OAuth2 凭证。具体操作如下：

1. 转到 https://console.cloud.google.com/apis/credentials
   （如果您没有 Google Cloud 项目，请创建一个 — 免费）
2. 点击顶部的 **'+ CREATE CREDENTIALS'** > **'OAuth client ID'**
3. 如果提示配置同意屏幕：
   - 用户类型：**外部**（或者内部用于 Google Workspace）
   - 应用名称：'GBrain'（任何名称都可以）
   - 范围：添加您需要的那些：
     - Gmail：`https://www.googleapis.com/auth/gmail.readonly`
     - Calendar：`https://www.googleapis.com/auth/calendar.readonly`
     - Contacts：`https://www.googleapis.com/auth/contacts.readonly`
   - 测试用户：添加您自己的电子邮件地址
4. 创建 OAuth 客户端 ID：
   - 应用程序类型：**桌面应用**
   - 名称：'GBrain'
5. 点击 **'创建'** — 复制**客户端 ID** 和**客户端密钥**
6. 启用您需要的 API：
   - Gmail：https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - Calendar：https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   在每个上面点击 **'启用'**。

将客户端 ID 和客户端密钥粘贴给我。"

验证：
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "通过：Google OAuth 凭证已设置" \
  || echo "失败：缺少 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET"
```

然后运行 OAuth 流程：
```
// 配方首次使用这些凭证时，它将：
// 1. 打开浏览器到 Google 同意 URL
// 2. 用户授予访问权限
// 3. 脚本接收授权代码，交换为访问 + 刷新令牌
// 4. 将令牌存储在 ~/.gbrain/google-tokens.json 中
// 5. 令牌过期时自动刷新（刷新令牌是长期有效的）
```

**停止直到 OAuth 凭证验证通过。**

### 步骤 2：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/credential-gateway
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"type":"CLAWVISOR_OR_GOOGLE"}}' >> ~/.gbrain/integrations/credential-gateway/heartbeat.jsonl
```

告诉用户："Credential gateway 已设置。Email-to-brain 和 calendar-to-brain
现在可以访问您的 Google 服务。"

## 棘手的地方

1. **ClawVisor 任务目的必须**宽泛**。""Email triage" 太窄，
   会阻止合法请求。使用涵盖您可能想要做的所有事情的宽泛目的
   与电子邮件。意图验证模型根据目的检查每个
   请求。窄 = 被阻止。

2. **Google OAuth 令牌过期。** 访问令牌持续约 1 小时。刷新令牌
   是长期有效的，但可以被撤销。将两者都存储在 `~/.gbrain/google-tokens.json` 中，
   权限为 0600。脚本应在 401 时自动刷新。

3. **处于"测试"模式的 Google 同意屏幕**限制为 100 个用户，令牌
   每周过期。对于个人使用，这没问题。对于生产，发布应用。

4. **多个 Google 账户。** 如果您有工作 + 个人 Gmail，您需要在
   OAuth 流程中单独授权每个账户。ClawVisor 自动处理此问题。

## 如何验证

1. **ClawVisor：** `curl $CLAWVISOR_URL/health` 返回 OK。
2. **Google OAuth：** 令牌存在于 `~/.gbrain/google-tokens.json`。
3. **Gmail 访问：** 运行电子邮件收集器 — 它应拉取最近的消息。
4. **Calendar 访问：** 运行日历同步 — 它应拉取今天的事件。

## 成本估算

| 组件 | 月成本 |
|-----------|-------------|
| ClawVisor | $0（免费层） |
| Google OAuth | $0（免费，个人使用无需计费） |

---
*GBrain Skillpack 的一部分。另请参阅：[Email-to-Brain](email-to-brain.md)、[Calendar-to-Brain](calendar-to-brain.md)*
