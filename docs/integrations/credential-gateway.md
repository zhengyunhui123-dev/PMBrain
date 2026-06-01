# 凭证网关（ClawVisor / Hermes）

三个让 agent 变为现实的集成。没有它们，brain 是一个静态数据库。有了它们，它就活了。

### 14a. 凭证网关（ClawVisor / Hermes 网关）

EA 工作流需要 Gmail、Calendar、Contacts 和消息传递访问。Agent 绝不应直接持有 API 密钥。使用凭证网关来强制执行策略并在请求时注入凭证。

**OpenClaw：ClawVisor。** [ClawVisor](https://clawvisor.com) 是一个带有任务范围授权的凭证库和授权网关。

**服务：** Gmail（列表、读取、发送、草稿）、Google Calendar（CRUD）、Google Drive（列表、搜索、读取）、Google Contacts（列表、搜索）、Apple iMessage（列表、读取、搜索、发送）、GitHub、Slack。

**任务范围授权：** 每个请求必须包含来自已批准的常设任务的 `task_id`。任务声明：目的（详细，2-3 句话）、带有预期使用模式的授权操作、自动执行标志、生命周期（常设 vs 临时）。

**为什么这对 GBrain 很重要：** EA 工作流需要 Gmail（分类前的发件人查找）、Calendar（会议准备、参会者页面）、Contacts（丰富触发）和 iMessage（直接指令）。ClawVisor 让 agent 获得访问权限而不给它原始凭证。

**设置：**

1. 在 ClawVisor 仪表板中创建 agent，复制 agent token
2. 在环境变量中设置 `CLAWVISOR_URL` 和 `CLAWVISOR_AGENT_TOKEN`
3. 在仪表板中激活服务（Google、iMessage 等）
4. 创建具有宽泛范围的常设任务（狭窄的目的会导致错误阻止）
5. 将常设任务 ID 存储在 agent 内存中以供重用

**关键范围规则：** 在任务目的中要宽泛。"完整的执行助理电子邮件管理，包括收件箱分类、按任何条件搜索、读取电子邮件、跟踪线程"有效。"电子邮件分类"被拒绝。意图验证模型使用目的来判断每个请求是否一致 — 如果你的目的狭窄，合法请求将无法通过验证。

**Hermes Agent：内置网关。** Hermes 具有多平台消息传递（Telegram、Discord、Slack、WhatsApp、Signal、Email）和内置在其网关中的工具访问。使用 `config.yaml` 配置 API 凭证。网关守护程序管理连接并将 webhooks 路由到 agent 会话。对于 Google 服务，在网关配置中配置 OAuth 凭证。Hermes 的计划自动化可以通过网关的工具系统运行相同的 EA 工作流（电子邮件分类、日历准备、联系人丰富）。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。另请参阅：[数据输入](README.md)*
