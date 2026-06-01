# 教程：从零开始设置你的个人 AI agent + brain

到本教程结束时，你将拥有自己的 AI agent 在你控制的服务器上运行，通过 Telegram 与你对话，并有一个记住你告诉它的一切的 brain。端到端约两个小时，持续 $100 到 $150 每月。

如果今天我要从零开始搭建整个堆栈，这就是我会运行的安装。我是在与一位合作者进行设置会话时实时记录下来的（我们使用 Granola 来捕获屏幕，因为"这对典型人物来说已经太复杂了"）。本教程是那个会话的清理版本。

> "这是 Apple I，我们只是在这里焊接面包板。"

如果你只想要 **brain 层**（没有 agent，没有 Telegram，只是将 gbrain 作为你已经使用的 MCP 客户端的内存），请跳到 INSTALL.md 中的 [CLI 独立安装](../INSTALL.md#2-cli-standalone)。如果你想将整个 agent **与团队共享**，请阅读[公司 brain 教程](company-brain.md)。本教程是单人、完整堆栈、在 Telegram 上与之对话的路径。

---

## 你要构建什么

一个带有四个部分的个人 AI agent：

- **一个 brain**（git 仓库）。你的知识库，不断摄取和增长。
- **一个工具链**（通过 AlphaClaw 的 OpenClaw）。为 LLM 提供工具、内存和集成的运行时。
- **一个聊天界面**（Telegram）。你如何与它对话。
- **Skills**（通过 GBrain 安装的 60+）。agent 可以调用的可重用能力。

架构：

```
Telegram → AlphaClaw (工具链) → OpenClaw (agent) → GBrain (知识/skills) → Supabase (嵌入/搜索)
```

Git 仓库是记录系统。整个东西默认是多玩家的：任何连接到仓库的 agent 都可以工作。冲突通过 git 解决。

---

## 先决条件

| 要求 | 为什么 |
|---|---|
| GitHub 账户（组织或个人） | 用于存储 agent + brain 的两个仓库 |
| Render 账户 | 用于托管 agent 运行时 |
| Telegram 账户 | 用于与你的 agent 对话 |
| API 密钥：至少 OpenAI、Anthropic | 嵌入 + Claude 模型 |
| 约 $100 到 $150 每月 | Render Pro + Supabase + API 使用 |

---

## 步骤 1：创建两个 GitHub 仓库

你需要两个仓库，而不是一个。

1. **工作区仓库。** Agent 配置、skills、内存、crons。示例名称：`your-org/myagent`。私有。
2. **Brain 仓库。** 知识库、people pages、会议笔记，agent 读取和写入的所有内容。示例名称：`your-org/myagent-brain`。私有。

```
GitHub → 新建仓库 → your-org/myagent           (工作区)
GitHub → 新建仓库 → your-org/myagent-brain     (brain)
```

两个仓库都从空开始。GBrain 将在首次安装时填充 brain 仓库的默认结构。

---

## 步骤 2：生成细粒度的个人访问令牌

GitHub → 设置 → 开发人员设置 → 个人访问令牌 → 细粒度令牌。

- **名称：** `myagent-token`
- **过期时间：** 1 年（或如果可用则不过期）
- **仓库访问：** 仅选择两个仓库
- **权限：** 对两个仓库的读取和写入访问（内容、元数据、拉取请求）

GitHub 的细粒度 PAT UI 很痛苦。你可能需要在创建仓库后重新加载页面，它们才会在选择器中显示。这是整个设置中最糟糕的部分。坚持下去。

保存此令牌。你需要它用于 AlphaClaw 设置。

---

## 步骤 3：创建 Telegram bot

1. 打开 Telegram，给 [@BotFather](https://t.me/BotFather) 发消息
2. 发送 `/newbot`
3. 为你的 bot 命名（随便你想要什么）
4. 获取 bot 令牌
5. 保存它。你需要它用于 AlphaClaw 设置。

---

## 步骤 4：通过 Render 上的 AlphaClaw 部署

AlphaClaw 是管理 OpenClaw 部署的设置工具链。

1. 转到 [alphaclaw.com](https://alphaclaw.com)
2. 输入你的 **工作区仓库**（不是 brain 仓库）：`your-org/myagent`
3. 如果仓库已存在，选择"使用现有"
4. 输入来自步骤 2 的 GitHub PAT
5. 输入来自步骤 3 的 Telegram bot 令牌
6. 部署

Render 将构建一个带有工具链的 Docker 容器。首次部署需要约 5 分钟。

**内存很重要。** 如果实例在安装期间内存不足，请升级到 Render Pro。基础层对于一起运行 GBrain + OpenClaw 来说太小了。我的生产实例运行 48 核和 64GB RAM（约 $1,500 每月），但对于新设置来说这太过了。Pro 层（$85 每月）是最小可行方案。

---

## 步骤 5：添加 provider API 密钥

在 AlphaClaw UI（Providers 选项卡）中：

- **OpenAI API Key。** 如果你使用 OpenAI provider，则需要用于嵌入。
- **Anthropic API Key.** 需要用于 Claude（agent 与之对话的主要模型）。
- **Perplexity API Key.** 可选，用于网页搜索。
- **Voyage API Key.** 可选，OpenAI 的嵌入替代方案。
- **ZeroEntropy API Key.** 推荐。GBrain 默认附带 ZeroEntropy 作为默认嵌入器 + 重排序器，因为它比 OpenAI 快约 2×，便宜约 2.6×。

你可以在多个 agents 之间使用相同的密钥。

---

## 步骤 6：安装 GBrain

一旦 OpenClaw 正在运行：

```bash
gbrain install
```

这会安装：

- 约 60 个 skills
- 约 9 个 skill packs
- 默认 brain 结构
- MCP 服务器配置
- Supabase 连接（用于嵌入和搜索）

GBrain 使用其默认目录结构、skill 文件和配置填充 brain 仓库。从这一点开始，agent 具有工作内存并可以访问每个 skill。

---

## 步骤 7：设置 Supabase（嵌入和搜索）

GBrain 使用 Supabase 进行大规模向量嵌入和全文搜索。我遇到了三个设置陷阱，请按此顺序逐步解决。

### 7a. 创建项目并打开 pgvector

1. 在 [supabase.com](https://supabase.com) 创建一个 Supabase 项目。选择靠近你的 Render 主机运行区域的区域。
2. 在 Supabase 仪表板中，转到 **数据库 → 扩展**。
3. 找到 `vector`（pgvector 扩展）并切换打开它：

如果你跳过这一步，每当 GBrain 尝试创建其 schema 时，每个嵌入写入都会失败并显示"type vector does not exist"。pgvector 是存储嵌入的东西；schema 迁移在没有它的情况下拒绝运行。在 UI 中五秒钟；如果你忘记的话，调试一小时。

### 7b. 获取 CONNECTION POOLER 连接字符串，而不是直连的那个

在 **项目设置 → 数据库 → 连接字符串** 中，Supabase 为你显示了两个选项。它们看起来几乎相同。使用正确的那个。

- **直连**（端口 5432）。直接连接到 Postgres 实例。仅 IPv6。如果你的 Render 主机没有 IPv6 出站（默认情况下大多数没有），将会失败。
- **连接池器**（端口 6543，主机名以 `aws-0-...pooler.supabase.com` 开头）。通过 Supabase 的 pgbouncer 对话。通过 IPv4 工作。在并行工作器的连接风暴中存活。

你需要 **连接池器** 字符串。格式如下所示：

```
postgresql://postgres.YOUR-PROJECT:YOUR-PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres
```

通过以下方式配置它：

```bash
gbrain config set database_url "postgresql://postgres.YOUR-PROJECT:YOUR-PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
```

### 7c. 如果你的主机仅支持 IPv4，请购买 IPv4 附加组件

即使使用池器，某些 Supabase 区域和一些 Render 计划也会遇到 IPv6 解析问题。如果你的 `gbrain doctor` 显示连接失败，并且错误提到"network unreachable"或在连接时永远挂起，你需要 Supabase 的 **IPv4 附加组件**。

在 Supabase 仪表板中，**项目设置 → 附加组件 → IPv4 地址**。约 $4 每月。切换打开，等待一分钟，重试连接。在我学会直接提前购买之前，这在多次安装中困扰了我。

### 7d. 验证连接

```bash
gbrain doctor
```

在 schema、连接性、pgvector 扩展、嵌入 provider 上显示绿色对勾。如果其中任何一个是黄色，消息将告诉你遇到了哪个陷阱（以及要重新访问 7a / 7b / 7c 中的哪个）。

### 操作说明

Supabase 通常是扩展瓶颈，而不是 CPU 或 LLM 调用。如果你正在进行大量摄取（电子邮件、日历、Slack 流式传输），请尽早从小型升级到大型 DB 实例。不要等到小型实例窒息；症状（静默失败插入、同步超时、嵌入回填停滞）看起来都像不同的 bug，但都是同一个 bug。

---

## 步骤 8：验证和聊天

1. 打开 Telegram
2. 给你的 bot 发消息
3. 它应该使用 OpenClaw + GBrain 响应

发送测试消息。如果它用上下文感知响应并且可以搜索 brain，你就上线了。

---

## 架构说明

### Git 作为记录系统

Brain 仓库就是 brain。任何可以读取和写入 git 仓库的 agent 都可以参与。这使得架构本质上是多玩家的：多个 agents 可以共享一个 brain，在不同的部分工作，并通过 git 解决冲突。

### 瘦客户端 vs 胖客户端

- **胖客户端**（我的生产设置）。OpenClaw + AlphaClaw + GBrain + 200 个 crons + 电子邮件处理 + Slack + 日历。约 $1,500 每月。实时处理所有内容。
- **瘦客户端**（本教程构建的）。OpenClaw + GBrain + Telegram。约 $85 每月。聊天驱动，按需。

GBrain 的目标是使瘦客户端与胖客户端一样出色。大多数用户将从瘦客户端开始并成长。

### MCP 服务器

GBrain 公开了一个模型上下文协议服务器，支持 agent 间通信和与外部系统的集成。这是你如何添加对你产品的 API、数据库或其他服务的读取和写入访问权限。

### Brain 共享

Brains 通过 git 共享。我的主要 agent 可以通过将内容推送到其仓库来填充另一个 agent 的 brain。MCP 层支持跨 agent brain 查询。只需推送到 git 仓库，另一个 agent 就会在下次同步时获取它。

---

## 这需要多少钱

| 组件 | 每月成本 |
|-----------|-------------|
| Render Pro（最小可行） | 约 $85 |
| Supabase（小型） | 免费到 $25 |
| OpenAI API（嵌入） | $5 到 $20（如果你使用 ZeroEntropy 作为默认，则少得多） |
| Anthropic API（Claude） | $50 到 $500（取决于使用量） |
| **总计最小值** | **约 $100 到 $150 每月** |

我的生产设置约 $10,000 每月，但那是 10 个实例、200 个 crons、实时处理电子邮件和 Slack 和日历、运行子 agents。这不是你在第一天需要的。

> "明年它不会花费 $10,000 每月。它会花费 $1,000 每月。然后后年，它会是 $100 每月，然后每个人都会拥有它。"

---

## 常见问题

1. **Render 在安装期间内存不足。** 升级到 Pro 层。
2. **GitHub PAT 看不到仓库。** 创建仓库后重新加载页面。确保细粒度令牌具有正确的仓库选择。
3. **Telegram bot 没有响应。** 检查 AlphaClaw 中的 bot 令牌。确保 Render 实例实际正在运行。
4. **大量摄取时 Supabase 瓶颈。** 在小型实例窒息之前升级 DB 实例大小。
5. **GBrain.io 配置失败。** 托管实例可能需要 Pro 层。检查 AlphaClaw UI 中的机器分配。

---

## 你构建了什么

你现在拥有在 Render 上运行的个人 AI agent，在 Telegram 上与你对话，并有一个摄取并记住你告诉它的一切的 brain。每次对话都被索引，每个新实体（人物、公司、交易、概念）都获得自己的页面， overnight enrichment 守护进程在你睡觉时去重和合并。你醒来时，agent 比你睡觉时更聪明。

接下来要去哪里：

- **连接摄取**来自外部系统。电子邮件、日历、语音通话、推文、Slack。skills 已经安装；你只需配置凭证。参见[`docs/integrations/`](../integrations/)以获取每来源配方。
- **将你现有的 AI 客户端**（Claude Code、Cursor、Claude Desktop）连接到同一个 brain。参见[`docs/mcp/`](../mcp/)以获取每客户端设置。
- **正确设置 dream 周期。** autopilot 守护进程默认运行 overnight enrichment，但你可以调整它的行为。参见[`docs/architecture/`](../architecture/)以获取完整周期参考。
- **向你的 brain 添加队友**，或者将整个东西搭建为公司 brain。参见[公司 brain 教程](company-brain.md)以获取多用户演练。

问题、陷阱或值得分享的胜利？在 [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain/issues) 开 issue。
