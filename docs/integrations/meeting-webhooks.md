# 会议和通话 Webhooks

### 14b. Circleback — 通过 Webhooks 进行会议摄取

[Circleback](https://circleback.ai) 记录会议，生成带有发言人日记化的记录，并在完成时触发 webhooks。

**Webhook 设置：**

1. 在 Circleback 仪表板 -> 自动化 -> 添加 webhook
2. URL：`{your_agent_gateway}/hooks/circleback-meetings`
3. Circleback 提供用于 HMAC-SHA256 签名验证的签名密钥
4. 将签名密钥存储在你的 webhook 转换器中以进行验证

**Webhook 负载：** 带有 id、名称、参会者、笔记、行动项、完整记录、日历事件上下文的会议 JSON。

**签名验证：** 标头 `X-Circleback-Signature` 包含 `sha256=<hex>`。使用 `HMAC-SHA256(body, signing_secret)` 进行验证。拒绝未验证的 webhooks。

**API 访问的 OAuth：** Circleback 使用动态客户端注册（OAuth 2.0）。访问令牌在约 24 小时后过期，通过刷新令牌自动刷新。将凭证存储在 agent 内存中。

**流程：** Webhook 触发 -> 转换验证签名 + 规范化 -> agent 唤醒 -> 通过 API 拉取完整记录 -> 创建 brain 会议页面 -> 传播到实体页面 -> 提交到 brain 仓库 -> `gbrain sync`。

### 14c. Quo（OpenPhone）— SMS 和通话集成

[Quo](https://openphone.com)（以前称 OpenPhone）提供带有 SMS、通话、语音邮件和 AI 记录的业务电话号码。

**Webhook 设置：**

1. 在 Quo 仪表板 -> 集成 -> Webhooks
2. 为以下注册 webhooks：`message.received`、`call.completed`、`call.summary.completed`、`call.transcript.completed`
3. 将所有指向：`{your_agent_gateway}/hooks/quo-events`
4. 在 agent 内存中存储已注册的 webhook ID

**入站文本的工作方式：**

- Webhook 触发，包含发件人电话、消息文本、对话上下文
- Agent 通过电话号码在 brain 中查找发件人
- 向用户的消息平台展示发件人身份 + brain 上下文
- 起草回复以供批准（未经明确许可绝不自动回复）

**入站通话的工作方式：**

- `call.completed` 触发 -> 如果持续时间 > 30 秒，通过 API 获取记录和 AI 摘要
- 摄取到 brain（位于 `meetings/` 的会议风格页面）
- 更新相关人员和公司页面

**API 身份验证：** `Authorization` 标头中的裸 API 密钥（无 Bearer 前缀）。

**关键端点：** `POST /v1/messages`（发送 SMS）、`GET /v1/messages`（列表）、`GET /v1/call-transcripts/{id}`、`GET /v1/conversations`。

---

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。另请参阅：[数据输入](README.md)*
