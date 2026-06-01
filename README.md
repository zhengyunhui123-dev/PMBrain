# PMBrain（原 GBrain）

**搜索给你原始页面。PMBrain 给你答案。** 这是你的 AI 智能体一直缺少的大脑层——唯一一个在一个框中完成综合、图遍历和缺口分析的工具。

我是 Garry Tan，Y Combinator 的总裁兼首席执行官。我构建 PMBrain 来运行我自己的 AI 智能体。它是我的 OpenClaw 和 Hermes 部署背后的生产大脑：**146,646 个页面，24,585 人，5,339 家公司**，66 个 cron 作业自主运行。我的智能体在我睡觉时摄取会议、电子邮件、推文、语音通话和原始想法。它丰富它遇到的每个人和每家公司。它在夜间修复自己的引用并整合记忆。我醒来时比睡觉时更聪明——你也会。

**现在它也可以作为公司大脑使用。** 团队中的每个人都有自己的大脑切片，按登录范围划分。当你查询时，你只能看到你被允许看到的内容——永远不会看到其他人的笔记，永远不会看到其他团队的数据。我们在你可以读取大脑的每种方式（搜索、列表、查找、多源读取）上进行了模糊测试，结果为零泄漏。将 PMBrain 作为你团队共享的机构记忆——正是 YC 刚刚在其创业公司征集请求（Request for Startups）中提出的 [company-brain](https://www.ycombinator.com/rfs#company-brain) 形态。如果你在那个领域建设，你不妨在这个基础上构建。** [教程：将 PMBrain 设置为你的公司大脑 →]（docs/tutorials/company-brain.md）**

许多个人知识系统只给你关键词匹配和框内 grep。PMBrain 做到了这一点，并添加了其他没有人一起提供的两件事：

- **一个综合层，给你实际答案。** 跨人物、公司、交易和想法的综合、引用良好的散文。不是"这里有 10 个提到你的查询的块"；而是带有引用和对大脑尚不知道的内容的明确说明的实际答案。缺口分析是改变你使用大脑方式的部分。
- **一个自动连线的知识图谱。** 每次页面写入都会提取实体引用并创建类型化边（`attended`、`works_at`、`invested_in`、`founded`、`advises`），无需 LLM 调用。问"谁在 Acme AI 工作？"或"Bob 这个季度投资了什么？"并得到仅凭向量搜索无法达到的答案。基准测试：**在 240 页 Opus 生成的富散文语料库上，P@5 49.1%，R@5 97.9%**，比其禁用图谱的变体以及 ripgrep-BM25 + 仅向量的 RAG 高出 31.4 个百分点的 P@5。完整的 BrainBench 记分卡位于兄弟 [gbrain-evals](https://github.com/garrytan/gbrain-evals) 仓库中。

构建一个 10 万页大脑的目的是将其用作战略护城河。永远不丢失上下文。查询你自己头脑中的内容，而无需重新阅读。大脑层使护城河可用。7x24 小时的梦想周期使其保持敏锐。两者都运行在你的硬件、你的数据库、你的密钥上。

构建一个全天候运行的守护进程来摄取、丰富和整合，比让聊天中的智能体努力工作更容易。PMBrain 就是那个守护进程，已经通用化。30 分钟内安装完成。你的智能体完成工作。随着我的个人智能体变得更聪明，你的也一样。

> **约 30 分钟到一个完全工作的大脑。** 数据库在 2 秒内准备就绪（PGLite，无服务器）。你只需回答有关 API 密钥的问题。

> **LLM：** 获取 [`llms.txt`](llms.txt) 以获取文档地图，或获取 [`llms-full.txt`](llms-full.txt) 以获取在同一获取中内联核心文档的相同地图。**智能体：** 从 [`AGENTS.md`](AGENTS.md) 开始（如果你使用的是 Claude Code，则从 [`CLAUDE.md`](CLAUDE.md) 开始）。

## 这是什么样子

假设你明天要和 Alice 开会。你想走进会议室时记得她从事什么工作、你们上次谈话是什么时候、以及你们之间还有什么未定的事情。以下是你要输入的内容，以及你会得到的内容。

**你问：**

> "明天和 Alice 开会前，我需要知道什么？"

**大多数个人知识工具会给你返回一个页面列表。** 类似于：

```
1. people/alice — Alice 在 Acme 运行工程……
2. meetings/2026-03-15-alice-q1 — 与 Alice 的 Q1 产品评审……
3. meetings/2026-01-08-acme-kickoff — 与 Acme 团队的启动会议……
4. customers/acme — Acme 是一家我们合作的 B 轮金融科技公司……
5. notes/2026-04-22 — 与 Alice 关于定价的快速聊天……
```

五个页面，你现在必须自己打开并阅读才能真正做好准备。工具找到了正确的材料，但它没有完成工作。

**PMBrain 给你返回答案，并附带来源：**

```
Alice 在 Acme（一家 B 轮金融科技公司）运行工程。你上次谈话
是在 4 月 22 日的一次快速定价聊天中。那次谈话中还有三件事
仍然未定：

1. 她欠你新层级的安全评审
   （截止日期是 5 月 1 日；此后没有更新）。
2. 你承诺了 500 席层级的定价
   （你 4 月 25 日发送；尚未收到回复）。
3. 她提到他们正在招聘 CISO；你说你会从你的网络中介绍
   某人。

提醒：自 4 月 22 日（六周前）以来，没有任何关于 Alice 或 Acme 的内容
添加到大脑中。她可能通过电子邮件
或 Slack DM 回复了，这些渠道大脑看不到。值得在假设任何这些内容
仍然是最新的之前，请她赶上进度。
```

每个声明背后都有一个源页面。"提醒"部分告诉你大脑尚不知道的内容，所以你可以直接问 Alice，而不是感到惊讶。大脑刚刚完成了你的会议准备。

这就是搜索引擎和大脑之间的区别。搜索找到页面。大脑为你阅读它们并写出答案。

## 安装

PMBrain 旨在由 AI 智能体安装和操作。最快的路径是让你的智能体为你做这件事。下面的 CLI 和 MCP 路径适用于想要自己连接它的人。

### 让你的智能体安装它（推荐）

如果你还没有运行 AI 智能体平台，请从其中之一开始。两者都设计用于读取 PMBrain 的安装协议并执行它：

- **[OpenClaw](https://github.com/openclawagents/openclaw)** — 在 Render 上部署 [AlphaClaw](https://render.com/deploy?repo=https://github.com/chrysb/alphaclaw)（一键，8GB+ RAM）
- **[Hermes](https://github.com/openclawagents/hermes)** — 在 [Railway](https://github.com/praveen-ks-2001/hermes-agent-template) 上部署（一键）

然后将其粘贴到你的智能体中：

```
检索并遵循以下位置的说明：
https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md
```

智能体安装 PMBrain，创建大脑，询问你的 API 密钥，加载 43 个技能，配置梦想周期，并端到端验证安装。约 30 分钟。你回答问题，它完成工作。

> **以前从未设置过 AI 智能体平台？** [个人大脑教程](docs/tutorials/personal-brain.md) 从头到尾引导整个路径——选择 OpenClaw 与 Hermes、部署它、指向 INSTALL_FOR_AGENTS.md、获取 API 密钥以及验证第一个查询。如果上面有任何内容是新的，请从那里开始。

### 安装到现有智能体中

已经运行 Codex、Claude Code、Cursor 或其他编码智能体？粘贴相同的指令：

```
检索并遵循以下位置的说明：
https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md
```

这适用于任何可以读取 HTTPS 上的文件并执行 shell 命令的智能体。已使用 Codex、Claude Code、Claude Cowork、Cursor 和 AlphaClaw 测试。

### CLI 独立运行（无智能体）

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite     # 2 秒；无服务器，无 Docker
gbrain doctor            # 验证健康状况
gbrain import ~/notes/   # 索引你的 markdown
gbrain query "我的笔记中出现了什么主题？"
```

Postgres 大规模、Supabase 和瘦客户端设置路径位于 [`docs/INSTALL.md`](docs/INSTALL.md)。

### 将 PMBrain 连接到你的 AI 客户端（MCP）

PMBrain 通过 MCP（stdio 和 HTTP）公开 30+ 工具。具体片段取决于你使用的客户端：

- **[Claude Code](docs/mcp/CLAUDE_CODE.md)** — 一个命令：`claude mcp add gbrain -- gbrain serve`。零服务器，零隧道。
- **[Cursor / Windsurf / 任何 stdio MCP 客户端](docs/mcp/CLAUDE_CODE.md)** — 相同形状，将 `{"command": "gbrain", "args": ["serve"]}` 添加到你的 MCP 配置。
- **[Claude Desktop (Cowork)](docs/mcp/CLAUDE_DESKTOP.md)** — 设置 → 集成 → 添加你的 HTTP 服务器 URL。仅远程；本地 `claude_desktop_config.json` 不适用于远程服务器。
- **[Claude Cowork（团队计划）](docs/mcp/CLAUDE_COWORK.md)** — 组织所有者在组织设置 → 连接器下添加连接器。
- **[Perplexity Computer](docs/mcp/PERPLEXITY.md)** — 设置 → 连接器 → 添加 URL + bearer 令牌。需要 Pro 订阅。
- **[ChatGPT](docs/mcp/CHATGPT.md)** — 使用带有 PKCE 的 OAuth 2.1（硬性要求）。从管理仪表板注册一个 `chatgpt` 客户端，授权类型为 `authorization_code`。

对于 HTTP 服务器本身：

```bash
gbrain serve              # stdio MCP（本地子进程；适用于 Claude Code、Cursor、Windsurf）
gbrain serve --http       # 带有 OAuth 2.1 + 管理仪表板（位于 /admin）的 HTTP MCP
                          #（Required for Claude Desktop, Cowork, Perplexity, ChatGPT）
```

HTTP 服务器包括 DCR 风格的客户端注册、范围门控访问（`read` / `write` / `admin`）和速率限制。部署指南（ngrok、Railway、Fly.io）位于 [`docs/mcp/`](docs/mcp/) 下。

## 两种查询大脑的方式

原始检索（大多数个人知识工具提供的）和一个给你实际答案的综合层。它们服务于不同的工作。

```bash
# 原始检索：按混合评分排名的前几页，快速，无 LLM 成本
gbrain search "谁在投资组合公司从事 AI 智能体工作？"

# 大脑层：带有引用和缺口分析的综合答案
gbrain think "谁在投资组合公司从事 AI 智能体工作？"
```

**`gbrain search`** 返回检索到的前几页，按混合评分排名（向量 + 关键词 + RRF + 源层级提升 + 重排序器）。当你想要原始材料进行浏览时使用它：智能体上下文窗口、引用查找、查找特定引号。

**`gbrain think`** 运行相同的检索，然后跨结果撰写综合答案，并明确引用源页面以及大脑尚不知道的内容的诚实说明。缺口分析是差异化因素：答案告诉你页面何时过时、声明何时未被引用、两页何时相互矛盾、何时存在你应该填补的空白。

**为什么它会复合。** 将大脑层与 `find_trajectory` 配对，你会得到这样的答案：*"公司的指标如何变化，现在团队看起来是什么样子，他们承诺/分享什么，我们上次见面是什么时候，我可以在这里提供什么增值"*：评分良好、引用良好，一次性完成。这就是战略护城河。这就是为什么构建一个 10 万页的大脑值得付出努力。

`gbrain agent run "..."` 通过 Minions 队列将相同的表面暴露给子智能体，具有崩溃安全的二阶段持久性。相同的答案，持久的。

## 如何获取数据

一个命令，本地或托管，同步接收：

```bash
gbrain capture "我想记住的想法"
gbrain capture --file ./notes/today.md
echo "从管道来" | gbrain capture --stdin
SLUG=$(gbrain capture "..." --quiet)
```

页面在一次移动中落到数据库和磁盘上。默认 slug `inbox/YYYY-MM-DD-<hash8>`，以便捕获聚集在可预测的分类位置。`~/.gbrain/inbox/` 中的收件箱文件夹源从 iOS 快捷方式 / AirDrop / Drafts / Finder 拾取任何放入的内容。

第三方技能包可以针对 `gbrain/ingestion` 处的版本化 `IngestionSource` 契约提供自定义摄取源（Granola、Linear、语音、OCR）。请参阅 [`docs/skillpack-anatomy.md`](docs/skillpack-anatomy.md)。

## 你大脑的形状（模式包）

大多数个人知识工具强制使用一种固定的布局：它们对"笔记"+"人物"+"标签"的想法。将 Notion 导出或你自己多年前的 Obsidian 保险库放在上面，智能体不知道 `Projects/` 文件夹是什么意思，或者 `Reading/` 是人物还是来源。

**gbrain 没有固定的布局。** 它附带捆绑的模式包，并在没有适合的模式包时让你编写自己的模式包：

- **`gbrain-base-v2`**（从 v0.41.22 开始的默认设置）— 15 种类型的 DRY/MECE 规范分类法（14 个规范 + `note` 包罗万象）：`person`、`company`、`media`、`tweet`、`social-digest`、`analysis`、`atom`、`concept`、`source`、`deal`、`email`、`slack`、`writing`、`project`、`note`。子类型/格式/来源推送到前置元数据中。响应问题 #1479 的分类法。
- **`gbrain-base`**（遗留，v0.41 及更早版本的大脑）— 原始 24 类型布局。为了保持向后兼容而保持捆绑；其上的人类可以通过 `gbrain onboard --check --explain` → `gbrain jobs submit unify-types --allow-protected --params '{"target_pack":"gbrain-base-v2"}'` 升级。
- **`gbrain-recommended`** — 使用 [`docs/GBRAIN_RECOMMENDED_SCHEMA.md`](docs/GBRAIN_RECOMMENDED_SCHEMA.md) 中的 13 个附加目录扩展 `gbrain-base`（来源、地点、旅行、对话、个人、公民、项目等）。使用 `gbrain schema use gbrain-recommended` 激活。
- **你自己的包** — `gbrain schema detect` 将你的实际文件系统集群到提议的类型中，`gbrain schema suggest` 在 detect 之上运行 LLM 传递，`gbrain schema review-candidates --apply` 提升你喜欢的类型。三个命令，大脑就知道你的形状。编写后继包（声明 `migration_from:` 以便现有大脑可以选择加入）：请参阅 [`docs/architecture/pack-upgrade-mechanism.md`](docs/architecture/pack-upgrade-mechanism.md)。

```bash
gbrain schema active                # 哪个包正在运行，哪个层级设置了它
gbrain schema list                  # 捆绑 + 已安装的包
gbrain schema detect                # 提议与你的文件系统匹配的类型
gbrain schema suggest               # 在 detect 之上的 LLM 优化提议
gbrain schema review-candidates     # 人工网关：提升 / 重命名 / 忽略
gbrain schema use my-pack           # 激活
```

活动包贯穿每个读取 + 写入路径：`parseMarkdown` 从包的路径前缀推断页面类型；`whoknows` 将专家路由范围限定为声明 `expert_routing: true` 的类型；`extract_facts` 仅在 `extractable: true` 的类型上运行；搜索缓存将包名称 + 版本折叠到其键中，以便在结构上不可能发生跨包污染。切换包，大脑重新解释自己；切换回来，什么都不会丢失。

七层解析链（每调用标志 → 环境变量 → 每源 DB 密钥 → 全大脑 DB 密钥 → `gbrain.yml` → `~/.gbrain/config.json` → `gbrain-base` 默认）。完整参考 + 创作指南：[`docs/architecture/schema-packs.md`](docs/architecture/schema-packs.md)。

## 教程

循序渐进的演练，充分利用 PMBrain。每个都让你从零到工作结果，带有具体命令和真实数字。

- [**从零开始设置你的个人 AI 智能体 + 大脑**](docs/tutorials/personal-brain.md) — 规范的全栈安装。两个 GitHub 仓库、一个 Telegram 机器人、Render 上的 AlphaClaw、OpenClaw + GBrain + Supabase。大约 2 小时端到端。
- [**将 PMBrain 设置为你的公司大脑**](docs/tutorials/company-brain.md) — 适用于 10-50 人团队的联邦、多用户、OAuth 范围机构记忆。约 90 分钟端到端。

更多演练正在进行中：将现有智能体（Claude Code、Cursor、OpenClaw、Hermes）连接到 GBrain 记忆层；使用创始人记分卡和会议准备为 VC 资金流设置 PMBrain；迁移现有 Notion 或 Obsidian 保险库；将代码库索引为可查询的代码大脑。完整教程索引：[`docs/tutorials/`](docs/tutorials/)。

想看到这里还没有的教程？[打开一个 issue](https://github.com/garrytan/gbrain/issues) 描述你想要记录的工作流。

## 它做什么（循环）

```
  信号   →   搜索   →   响应   →   写入   →   自动链接   →   同步
  （每条    （大脑优先  （由上下文     （页面 +    （类型化边     （cron
  消息）   检索）   告知的）    时间线）  + 反向链接）     保持新鲜）
```

- **信号检测器** 在你的智能体收到的每条消息上运行。捕获想法、实体提及、时间敏感的待办事项、姓名、链接。
- **大脑优先查找** 在任何外部 API 调用之前。你拥有的最便宜、最快、最个性化的信息来源。
- **自动链接** 在每次页面写入时触发。无 LLM 调用；对 `[[wiki/people/bob]]` 样式引用进行纯模式匹配。新实体 → 新页面存根 → 图谱增长。
- **Cron 驱动的丰富** 在你睡觉时运行：去重人物页面、修复引用、评分显著性、发现矛盾、准备明天的任务。

整个循环在 [`docs/architecture/topologies.md`](docs/architecture/topologies.md) 中通过图表描述。

## 能力

**混合搜索。** 向量（pgvector 上的 HNSW）+ BM25 关键词 + 倒数排名融合 + 源层级提升 + 意图感知查询重写。三种命名搜索模式（`conservative`、`balanced`、`tokenmax`）将成本/质量旋钮捆绑到单个配置键中。实时成本/召回比较在 [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md) 中。[`docs/evalu/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md)。默认：启用了 ZeroEntropy 重排序器的 `balanced`。每查询图信号注意到当顶部结果是该查询的枢纽时（邻接提升）、跨团队大脑被证实（跨源提升）或正在被来自健谈会话的弱块挤掉（会话降级）。运行 `gbrain search "<query>" --explain` 以查看每阶段归属：基本分数、触发的每个提升、它乘以了什么。`gbrain doctor` 提供一个 `graph_signals_coverage` 检查；`gbrain search stats` 显示触发计数和失败分解。

**自动连线的知识图谱。** 每次 `put_page` 从 markdown/wikilinks/类型化链接语法中提取实体引用，并为零 LLM 调用写入边。类型化边（`attended`、`works_at`、`invested_in`、`founded`、`advises`、`mentions`……）。通过 `gbrain graph-query` 进行多跳遍历。图谱正是产生比仅向量 RAG 高出 31.4 P@5 提升的原因。

**作业队列（Minions）。** BullMQ 形状、Postgres 原生的作业队列。持久的子智能体（通过二阶段 pending→done 持久性在崩溃中存活的 LLM 工具循环）、带有审计的 shell 作业、具有级联超时的子作业、用于出站提供商的速率租约、通过 S3/Supabase 存储的附件。用"将子智能体生成为即发即弃的 Promise"替换为可以从任何事情中恢复的东西。

**43 个精选技能。** 路由位于 [`skills/RESOLVER.md`](skills/RESOLVER.md)。涵盖信号捕获、摄取（想法 / 媒体 / 会议）、丰富、查询、大脑操作、引用修复、日常任务管理、cron 调度、报告、语音、灵魂审计、技能创建、评估框架和迁移。技能是 markdown 文件（工具不可知），打包为安装程序放入你的智能体工作空间的单个技能包。

**评估框架。** `gbrain eval longmemeval` 针对你的混合检索运行公共 [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) 基准测试。`gbrain eval export` + `gbrain eval replay` 捕获真实查询并针对代码更改重放它们（设置 `GBRAIN_CONTRIBUTOR_MODE=1`）。`gbrain eval cross-modal` 使用三个不同提供商的 Frontier 模型根据任务交叉检查输出。完整方法在 [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md) 中。

**大脑一致性。** `gbrain eval suspected-contradictions` 采样检索对、分层日期预过滤、查询条件 LLM 判断、持久缓存。暴露智能体已写入的要点 + 事实之间的矛盾。连接到每日梦想周期。

**智能体创作的模式（v0.40.7.0）。** 你的大脑有一个形状——存在什么页面类型（`person`、`meeting`、`paper`、`case`、`lab-result`）、它们链接到什么（`attended`、`authored`、`prescribed-by`）、什么事实被自动提取。默认附带 22 个通用类型，但你大脑的实际形状不是默认形状。智能体现在可以通过 14 个 `gbrain schema` CLI 动词 + 批量 MCP 操作（`schema_apply_mutations`，admin 范围，而不是 localOnly，以便远程智能体通过 HTTPS 访问它）代表你演化该形状。原子文件锁、带有智能体身份的审计日志、永远不会楔入并发写入器的 1000 行批次中的分块 UPDATE 回填。大脑不再是一堆笔记，而是变成具有结构的东西。**为什么它很重要：** [`docs/what-schemas-unlock.md`](docs/what-schemas-unlock.md) — 7 个杀手级用例（4000 个无形会议、创始人操作大脑、研究大脑、法律大脑、团队大脑、智能体作为共同策展人）。**5 分钟演练：**[`docs/schema-author-tutorial.md`](docs/schema-author-tutorial.md)。**智能体技能：**[`skills/schema-author/SKILL.md`](skills/schema-author/SKILL.md)。

## 集成

流入大脑的数据。每个集成都是一个配方——markdown + 设置提示——在 `recipes/` 中提供，可通过 `gbrain integrations list` 发现。

- **语音**：电话通话通过 Twilio + OpenAI Realtime（或 DIY STT+LLM+TTS）创建大脑页面。设置配方：[`recipes/twilio-voice-brain.md`](recipes/twilio-voice-brain.md)。
- **电子邮件 + 日历**：路由到大脑信号的 webhook 处理程序。[`docs/integrations/meeting-webhooks.md`](docs/integrations/meeting-webhooks.md)。
- **嵌入提供商**：涵盖 OpenAI（默认回退策略）、OpenRouter、Voyage、ZeroEntropy（默认）、Google Gemini、Azure OpenAI、MiniMax、Alibaba DashScope、Zhipu、Ollama（本地）、llama.cpp llama-server（本地）、LiteLLM 代理的 16 个配方。定价矩阵 + 决策树在 [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md) 中。
- **重排序器**：ZeroEntropy `zerank-2` 托管（默认为 `tokenmax` 模式）加上 v0.40.6.1 `llama-server-reranker` 配方，用于通过 llama.cpp 进行完全本地的交叉编码器重排序——针对相同的 `gateway.rerank()` 接缝运行 Qwen3-Reranker 或自托管的 ZeroEntropy 权重。设置演练在 [`docs/ai-providers/llama-server-reranker.md`](docs/ai-providers/llama-server-reranker.md) 中。
- **凭证网关**：保险库感知的密钥分发。[`docs/integrations/credential-gateway.md`](docs/integrations/credential-gateway.md)。
- **MCP 客户端**：支持每个主要的 MCP 客户端。[`docs/mcp/`](docs/mcp/) 每客户端设置。

## 架构

**两个引擎，一个契约。** PGLite（通过 WASM 的 Postgres 17，零配置，默认）用于最多约 50K 页的个人大脑。Postgres + pgvector（Supabase 或自托管）用于共享 / 大型 / 多机器部署。[`src/core/engine.ts`](src/core/engine.ts) 中的契约优先 `BrainEngine` 接口定义了两个引擎实现的约 47 个操作；CLI 和 MCP 服务器是从一个源生成的。

**大脑仓库是记录系统。** 你的知识作为 markdown 文件存在于常规 git 仓库（你的"大脑仓库"）中。GBrain 将仓库同步到 Postgres 以进行检索；git 中的删除成为数据库中的软删除。你可以发布公共子集、共享团队挂载、运行指向同事大脑服务器的瘦客户端设置。拓扑在 [`docs/architecture/topologies.md`](docs/architecture/topologies.md) 中。

**两个组织轴（大脑 ⊥ 源）。** *大脑*是一个数据库（你的个人大脑、你加入的团队挂载）。*源*是该大脑内的一个仓库（wiki、gstack、一篇文章、一个知识库）。路由位于 `.gbrain-source` 点文件中，并通过文档化的 6 层优先级链解析。完整图表在 [`docs/architecture/brains-and-sources.md`](docs/architecture/brains-and-sources.md) 中。

**为什么图谱很重要。** 向量搜索返回语义上接近的块。图谱返回事实上连接的块。混合搜索从两者中提取；每次写入时的自动链接保持图谱新鲜。深度潜水：[`docs/architecture/RETRIEVAL.md`](docs/architecture/RETRIEVAL.md)。

## 故障排除

**`gbrain import` 因 `expected N dimensions, not M` 而失败？** 运行 `gbrain doctor`。它将打印确切的 `gbrain config set ...` 或 `gbrain retrieval-upgrade` 命令来修复不匹配。你不需要删除 `~/.gbrain`。新的 `gbrain init --pglite` 在运行 init 之前从环境中的 API 密钥自动检测你的嵌入提供商：在运行 init 之前设置 `OPENAI_API_KEY`（或 `ZEROENTROPY_API_KEY` / `VOYAGE_API_KEY`），或显式传递 `--embedding-model <provider>:<model>`。设置了多个密钥时，init 会触发交互式选择器。在非 TTY 上下文中（CI、Docker）没有密钥时，init 退出 1，并附带粘贴就绪的设置提示；传递 `--no-embedding` 以延迟到运行时设置。请参阅 [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md) 以获取完整的提供商矩阵，以及 [`docs/operations/headless-install.md`](docs/operations/headless-install.md) 以获取 Docker/CI 排序。

**联邦大脑上的每小时 cron 同步不断超时？** v0.41.13.0 附带两个标志 + 推荐的模式。使用 shell `timeout(1)` 执行操作系统级终止和 gbrain 自终止将优雅地提前半分钟切换你的 cron 到每源循环：

```bash
gbrain sync --break-lock --all --max-age 1800
for src in $(gbrain sources list --json | jq -r '.[].id'); do
  timeout 600 gbrain sync --source "$src" --timeout 540 || true
done
```

当 `--timeout` 在导入中途触发时，`gbrain sync` 以状态退出 0：`partial` 和 `last_commit` 未更改——下一次运行重新遍历相同的差异，`content_hash` 短路已导入的文件。v98 `last_refreshed_at` 语义（不是 `acquired_at`）的 `--max-age 1800` 第一个命令自我修复由挂起的先前运行留下的楔入但活动的锁，因此健康长期运行的持有者在构造上是安全的。请参阅 [`CHANGELOG.md`](CHANGELOG.md) 中的 v0.41.13.0 条目以获取诚实的范围注释（提取 + 嵌入阶段运行完成；迁移后 v98 的 30 分钟推出窗口；完整同步触发器延迟到 v0.42+）。

**梦想周期在 Supabase 上静默丢失 wiki 链接？** v0.41.19.0 在结构上修复了错误类。引擎现在在 Supavisor 池化器闪烁时自重试每个批量写入（`addLinksBatch` / `addTimelineEntriesBatch` / `upsertChunks`），最坏情况等待 12 秒，覆盖完整的 5-10 秒断路器恢复窗口。`gbrain doctor` 通过新的 `batch_retry_health` 检查（读取 `~/.gbrain/audit/batch-retry-YYYY-Www.jsonl` 的最后 24 小时）暴露事件。要为异常缓慢的池化器调整：

```bash
# 默认值：3 次重试，基本 1 秒，最大 10 秒，去相关抖动。
# 无需发布即可按运算符覆盖：
export GBRAIN_BULK_MAX_RETRIES=5       # int >= 0；0 禁用重试
export GBRAIN_BULK_RETRY_BASE_MS=2000  # int > 0
export GBRAIN_BULK_RETRY_MAX_MS=15000  # int >= base
```

错误值在 `gbrain doctor` 启动时显示，并附带粘贴就绪的修复（不在周期中的第一次重试时）。仅 PGLite 的安装付出零成本——重试包装是引擎级别的，但 PGLite 没有池化器，因此重试永远不会在实践中触发。

**梦想周期因日志中的 `'No database connection: connect() has not been called'` 错误而丢失约 150 个链接行？** v0.41.27.0 使重试层在空数据库单例上自修复。在 `withRetry` 上的新 `reconnect` 回调在尝试之间重建连接；`PostgresEngine.batchRetry` 注入 `() => this.reconnect()` 以便引擎级批量写入在同一进程中通过其他东西在周期中途断开连接后存活。同一个版本：`gbrain capture` 不再在 CLI 退出后从后台 facts:absorb 工作器触发 `'No database connection'` stderr 行——op-dispatch finally 块在 `engine.disconnect()` 之前等待 `getFactsQueue().drainPending({timeout: 1000})`。要查找哪个代码路径仍在进程中途调用断开连接，请运行 `gbrain doctor --json | jq '.checks[] | select(.id=="batch_retry_health")'`；扩展检查现在暴露 24 小时断开连接调用计数和来自新的 `~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl` 审计的最新调用者帧。（关闭 #1570。）

**`gbrain brainstorm` 返回 `judge_failed: true` 且 0 个评分想法？** v0.41.21.0 关闭了导致其的两个错误。判断硬编码了 4K 令牌输出上限；对于超过约 40 个想法的任何运行，调用在 mid-JSON 处截断，解析器抛出。同一个版本关闭了 slash-form 定价未命中：`gbrain brainstorm --judge-model anthropic/claude-sonnet-4-6 --max-cost 5` 因 `BudgetExhausted reason=no_pricing` 而失败，因为每个定价站点只匹配冒号形式。这两种形状现在都有效。无配置更改，无架构迁移——`gbrain upgrade` 是完整的修复。

## 文档

- [`docs/INSTALL.md`](docs/INSTALL.md) — 每个安装路径，端到端
- [`docs/what-schemas-unlock.md`](docs/what-schemas-unlock.md) — 为什么模式很重要：7 个杀手级用例、类型化页面类型的结构参数、智能体协同策划模式（v0.40.7.0）
- [`docs/schema-author-tutorial.md`](docs/schema-author-tutorial.md) — 5 分钟演练：fork 捆绑包、添加自定义类型、回填现有页面、通过 `gbrain whoknows` 证明接线
- [`docs/architecture/`](docs/architecture/) — 系统设计、拓扑、检索理论
- [`docs/guides/`](docs/guides/) — 操作手册（子智能体路由、minion 部署、技能开发、大脑优先查找、想法捕获、尽职调查摄取）
- [`docs/integrations/`](docs/integrations/) — 连接外部数据源（语音、电子邮件、日历、嵌入提供商）
- [`docs/mcp/`](docs/mcp/) — 每客户端 MCP 设置（Claude Desktop、Code、Cursor、ChatGPT、Perplexity、Cowork）
- [`docs/eval/`](docs/eval/) — 评估框架、指标词汇表、方法
- [`docs/ethos/`](docs/ethos/) — 哲学（瘦线束、胖技能、markdown 作为配方、起源故事）
- [`AGENTS.md`](AGENTS.md) — 非 Claude 智能体的入口点
- [`CLAUDE.md`](CLAUDE.md) — Claude Code 的入口点（深度操作上下文）
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 贡献者指南、测试纪律、评估捕获模式
- [`SECURITY.md`](SECURITY.md) — OAuth 威胁模型、强化默认设置

## 贡献

运行 `bun run test` 进行快速循环，`bun run verify` 进行预推送门控，`bun run ci:local` 在本地运行完整的 Docker 支持的 CI 堆栈。详细的测试纪律在 [`CONTRIBUTING.md`](CONTRIBUTING.md) 中。

社区 PR 被批处理到发布波中，而不是逐个合并——请参阅 [`CLAUDE.md`](CLAUDE.md) 中的"PR wave workflow"部分。贡献者归属通过 `Co-Authored-By:` 预告片保持附加。我们在 [`CHANGELOG.md`](CHANGELOG.md) 中归功每个已接受的贡献。

如果你发现错误或想要功能：首先打开一个 issue。快速修复（错别字、文档错误、明显的回归）可以直接转到 PR。任何触及模式、检索排名、MCP 协议或安全边界的内容都需要在 issue 中进行设计讨论。

## 许可证 + 信用

MIT。我构建 PMBrain 来运行我的 OpenClaw 和 Hermes 部署——我的 AI 智能体背后的生产大脑。

起源故事：[`docs/ethos/ORIGIN.md`](docs/ethos/ORIGIN.md)。

社区 PR 贡献者在每个版本的 `CHANGELOG.md` 中加分。ZeroEntropy（[@zeroentropy](https://zeroentropy.dev)）用于作为默认附带的嵌入 + 重排序器堆栈。Voyage AI 用于非对称编码配方模板。Ramp Labs 用于搜索质量改进谱系。

---

**PMBrain 改造说明：**
本项目基于 GBrain 改造为项目管理 AI 大脑（PMBrain）。主要变更：
- 添加了项目管理相关的模式包（`pm-schema-pack`）
- 新增 2 个项目管理技能（`pm-status`、`pm-task`）
- 在循环周期中新增 3 个 PM 阶段（`project_health`、`risk_detect`、`report_gen`）
- 保留 GBrain 原有的知识管理和智能体能力
