# 教程

逐步演练，带你从零到可工作的结果。具体命令、真实数字，没有抽象优先的行话。每个教程都假设没有 prior GBrain 知识。

## 已发布

- [**从零开始设置你的个人 AI agent + brain**](personal-brain.md) — 规范的单人安装。两个 GitHub 仓库、Telegram bot、Render 上的 AlphaClaw、OpenClaw + GBrain + Supabase。端到端约 2 小时；持续约 $100 到 $150 每月。我今天会运行的完整堆栈安装。
- [**将 GBrain 设置为你的公司 brain**](company-brain.md) — 联邦的、多用户的、OAuth 范围的公司内存，适用于 10-50 人的团队。三个来源（shared / customers / internal-only）、每用户范围、作为 teammate 的首次合成查询。端到端约 90 分钟，演示约 $5 API 调用，25 人公司持续低于 $100 每月。

## 进行中

这些是路线图上接下来的教程。如果其中一个是你最需要的，请开 issue；这就是我们如何确定优先级。

- **将 GBrain 连接到你现有的 agent** — 适用于已经运行 [OpenClaw](https://github.com/garrytan/openclaw)、[Hermes](https://github.com/garrytan/hermes)、Claude Code、Cursor 或任何 MCP-aware client 的用户。将 GBrain 连入作为内存层，搭建 43 个 skills，在你的 agent 收到的下一条消息上看到 brain-first lookup 触发。

- **为 VC dealflow 设置 GBrain** — 操作员的配方。创始人的 people pages、带有类型化 Facts fence 的公司，携带 ARR / team-size / runway across dates、自动摄取的会议、连接一切的 deal pages。在真实工作流上展示 `gbrain whoknows`、`gbrain find_trajectory` 和 `gbrain founder scorecard`。

- **将你现有的 vault 迁移到 GBrain** — 适用于 Notion / Obsidian / Roam 用户，其 vault 与 GBrain 的默认布局不匹配。演练 `gbrain schema detect` → `suggest` → `review-candidates`，因此 brain 学习你的 shape，而不是强迫你学习它的。

- **将你的代码库索引为代码 brain** — 适用于开发人员。在代码仓库中初始化 brain，切换到 `voyage-code-3` 进行嵌入，使用 `gbrain code-def` / `gbrain code-refs` / `gbrain code-callers` 从任何 MCP-aware editor 语义地导航代码库。

- **使用 Ollama 或 llama.cpp 完全本地运行 GBrain** — 适用于隐私优先的部署。无云调用、无 API 密钥、无遥测。用一些检索质量换取完全本地控制。适用于受监管行业、气隙环境或仅仅是偏执。

- **设置 dream cycle** — 使 brain 自我维护的 overnight enrichment 守护进程。修复引用、去重 people pages、发现矛盾、按你配置的调度生成创始人记分卡。将静态知识库转变为在你睡觉时变得更聪明的 brain 的部分。

## 想写一个？

教程遵循 [Diataxis](https://diataxis.fr/) 教程模式：以学习为导向，在一次会话中引导学习者从零到工作结果，每一步产生可见的变化。如果你用 GBrain 做了一些有趣的事情并想写演练，现有的 [`company-brain.md`](company-brain.md) 是模型。开一个 PR。

## 相关文档

- **参考：** [`docs/architecture/`](../architecture/) — 系统设计、拓扑、检索理论
- **操作指南：** [`docs/guides/`](../guides/) — 面向任务的运行手册（sub-agent routing、minion deployment、skill development、brain-first lookup、idea capture、due diligence ingestion）。亮点：[scaling skills past 300](../guides/scaling-skills.md) — 适用于已经超出始终加载的 skill manifest 的 agents 的三层架构。
- **集成：** [`docs/integrations/`](../integrations/) — 连接外部数据源（语音、电子邮件、日历、嵌入提供商）
- **MCP 设置：** [`docs/mcp/`](../mcp/) — 每客户端设置（Claude Desktop、Code、Cursor、ChatGPT、Perplexity、Cowork）
- **安装路径：** [`docs/INSTALL.md`](../INSTALL.md) — 每个安装路径，端到端
