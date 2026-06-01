---
type: essay
title: "个人 AI 的 Homebrew"
subtitle: "为什么 Markdown 是代码，而你的 Agent 是包管理器"
author: Garry Tan
created: 2026-04-11
updated: 2026-04-11
tags: [ai, gbrain, gstack, markdown-is-code, open-source, software-distribution, agents, openclaw]
status: draft-v2
prior: "Thin Harness, Fat Skills"
---

# 个人 AI 的 Homebrew

`brew install` 给你别人的二进制文件。`npm install` 给你别人的源代码。两者都要求你理解工具、配置它、集成它、维护它。

如果软件分发方式不同呢？如果你可以用 plain English 描述一个能力，将该描述交给 AI agent，然后 agent 构建一个针对你的设置量身定制的原生实现呢？

这就是当 markdown 是代码时发生的事情。

## Markdown 是代码

这是一个真实的 skill 文件。这个教 AI agent 筛选电话：

```markdown
# Voice Agent — 你的电话号码

Caller → Twilio → <Stream> WebSocket → Voice Server (port 8765)
                                            ↕ audio
                                      OpenAI Realtime API
                                            ↓ tool calls
                                      Brain / Calendar / Telegram

## Call Routing

每个入站呼叫基于呼叫者电话号码 + brain 查找进行路由：

### Owner → 认证模式
- 发送加密随机 6 位代码到安全通道
- 呼叫者读回
- 匹配 → 完整助手模式（brain、日历、调度）
- 不匹配 → 视为未知呼叫者

### 已知人员，内圈（brain score ≥ 4）→ 转发
- 用 brain 上下文按名称问候
- 转移到手机
- 如果没有应答（30 秒超时），留言
- 用谁打电话和上下文发 Telegram

### 未知呼叫者 → 筛选
- 获取他们的姓名，在 brain 中查找他们
- 如果是内圈 → 提供转移
- 否则 → 留言
- 用电话号码创建 brain 条目（标记为 UNVERIFIED）
```

那不是伪代码。那不是文档。那是一个工作规范，像 Claude Opus 4.6 这样具有百万 token 上下文窗口的模型可以读取并实现。架构图告诉它组件。路由表告诉它逻辑。安全模型告诉它约束。Agent 读取这个文件，理解它，并构建 Twilio 集成、WebSocket 服务器、Telegram bot hooks、brain 查找，所有这些，都根据你的用户已有的基础设施来塑造。

Skill 文件是一个方法调用。它接受参数（你的电话号码、你的 brain、你首选的消息应用程序）。相同的 skill，不同的参数，不同的实现。过程就是包。模型就是运行时。

## 分发机制

传统的包管理器分发制品：编译的二进制文件、源代码 tarball、容器镜像。消费者运行别人的代码。

GBrain 分发配方：markdown 文件，用足够的特异性描述能力，使 AI agent 可以从头实现它们。消费者获得原生实现。没有依赖地狱。没有版本冲突。没有传递漏洞链。因为没有上游代码。只有关于构建什么和为什么的描述。

它是这样工作的：

1. **构建功能。** 实现语音 agent、会议摄取管道、电子邮件分类系统、投资尽职调查工作流， whatever。

2. **GBrain 捕获配方。** 不仅仅是代码。架构、集成点、故障模式、判断调用。一个编码完整能力的 markdown 文件。

3. **推送到仓库。** 开源。任何人都可以读取它。

4. **别人的 agent 拉取配方。** 读取 markdown。说："新配方可用：带有呼叫者筛选的 AI 语音 agent。要吗？" 用户说是。Agent 读取规范并构建它。

无安装。无配置向导。无 README。Agent 读取文档并弄清楚了。

## 为什么现在有效

两年前这不起作用。两件事改变了。

**上下文窗口达到百万 token。** 一个真实的会议摄取 skill 文件是 200+ 行。调用它的 enrichment skill 引用 brain schema、解析器、引用标准、五个外部 API 和交叉链接协议。实现此配方的 agent 需要同时将所有这些保持在工作内存中，同时也要理解用户现有的设置。在 8K token 时，不可能。在 128K 时，边际。在 1M 时，舒适。

**模型跨越了判断阈值。** 这是来自真实 enrichment 配方的一个片段：

```markdown
## Philosophy

brain 页面应该读起来像情报档案与
治疗师笔记的交叉，而不是 LinkedIn 抓取。我们想要：

- 他们相信什么 — 意识形态、世界观、第一性原理
- 他们正在构建什么 — 当前项目，下一步是什么
- 什么激励他们 — 雄心驱动力、职业弧线
- 什么让他们情绪化 — 愤怒、兴奋、防御、自豪
- 他们的轨迹 — 上升、平台期、转向、下降？
- 硬事实 — 角色、公司、资金、位置、联系信息

事实是桌面筹码。纹理是价值。
```

实现此配方的模型必须理解 LinkedIn 抓取和情报档案之间的区别。这是关于什么信息值得捕获以及如何权衡它的判断调用。GPT-3 无法做到这一点。GPT-4 可以某种程度上做到。Opus 4.6 做得很好。使能技术是足够聪明的模型来解释意图，而不仅仅是遵循指令。

## 配方实际包含什么

一个好的配方有五个部分：

**架构。** 组件图。什么与什么交谈，通过什么协议，有什么数据流。这是 agent 首先构建的骨架。

**路由逻辑。** 决策树。当 X 发生时，做 Y。当 Z 失败时，回退到 W。这是领域知识所在。语音 agent 配方编码呼叫路由。尽职调查配方编码如何处理 pitch deck vs. 财务模型 vs. 股权表。会议摄取配方编码如何将原始转录转换为可操作的情报。

**集成点。** 这个触摸什么外部系统？Twilio、Telegram、Gmail、Circleback、Slack、GitHub、Supabase，whatever。配方命名集成；agent 根据用户的配置弄清楚如何连接它们。

**判断调用。** 困难的部分。不是"发送电子邮件"而是"根据发件人重要性、时间敏感性和是否需要决策来决定此电子邮件是否值得呈现给用户。"跳过判断调用的配方产生浅层实现。判断调用是实际价值。

**故障模式。** 什么出错以及如何处理。"如果 Circleback token 过期，消息用户并要求他们重新连接。不要静默跳过。""如果呼叫者 ID 被欺骗，永远不要信任它进行身份验证。通过单独通道使用质询-响应代码。"没有故障模式的配方产生脆弱系统。

这是一个真实的例子。这是尽职调查配方的检测逻辑：

```markdown
## Detection

通过以下方式识别数据室材料：
- PDF 文件名："Data Deck"、"Intro Deck"、"Cap Table"、
  "Financial Model"、"Pitch Deck"、"Series [A-D]"
- 带有选项卡的电子表格：Revenue、Retention、Cohorts、
  CAC、Gross Margin、Unit Economics、ARR
- 用户说："data room"、"diligence"、"deck"、"pitch"
- 上下文：在 Diligence 主题中共享
```

这是用英语表达的模式匹配器。Agent 读取这个并知道如何对传入文档进行分类。无正则表达式。无文件类型配置。只是对模式的描述和模型关于给定文档是否匹配的判断。

## 挑选和选择

GBrain 不是单片。配方是独立的。取你想要的：

- **Voice agent** — 电话筛选、呼叫者 ID、brain 查找、消息路由
- **Meeting ingestion** — 转录处理、实体提取、行动项捕获、时间线更新
- **Email triage** — 收件箱扫描、优先级分类、草稿回复、调度提取
- **Enrichment pipeline** — 来自多个数据源的人员和公司研究，日记化到 brain 页面
- **Diligence processing** — 数据室摄取、PDF 提取、财务模型分析
- **Social monitoring** — X/Twitter 时间线分析、提及跟踪、叙事检测
- **Content pipeline** — 想法捕获、链接摄取、文章摘要

每个配方都是独立的。你的 agent 知道你已经拥有了什么。GBrain 每天 ping："自上次同步以来有 3 个新配方。要吗？" 你挑选。它构建。

因为源代码是英语，fork 是微不足道的。不喜欢语音 agent 处理未知呼叫者的方式？编辑 markdown。将"留言"更改为"首先问三个筛选问题。" 行为改变是因为规范改变了。

## 薄 harness、胖 skills 连接

这篇文章是续集。前传是"Thin Harness, Fat Skills"，它认为 100x AI 生产力的秘密不是更好的模型，而是更好的上下文管理。保持 harness 薄（运行模型的程序）。使 skills 胖（编码判断和过程的 markdown 过程）。

"Markdown 是代码"是分发推论。如果 skills 是胖 markdown 文件，并且如果模型足够聪明可以从 markdown 实现，那么 skills 就是可分发的软件。Skill 文件同时是：

- **文档** 供人类阅读
- **规范** 供实现 agent
- **包** 供分发系统
- **源代码** 供结果能力

四件制品折叠成一件。这就是为什么这与以前的所有包管理器都不同。`brew install` 将 formula 与二进制文件与文档与源代码分开。GBrain 折叠它们。Markdown 是所有四个。

## 底层架构

三层，与谈话相同：

**Fat skills** 在顶部。编码判断、过程、故障模式和领域知识的 Markdown 配方。这是 90% 的价值所在。这是被分发的。

**Thin harness** 在中间。运行模型的程序。文件操作、工具调度、上下文管理、安全执行。大约 200 行。OpenClaw 或任何等效的。harness 约束越少，配方可以表达的越多。

**Deterministic foundation** 在底部。数据库、API、CLI。相同的输入，相同的输出，每次。SQL 查询、HTTP 调用、文件读取。Skills 描述何时调用这些；harness 执行它们。

将智能向上推入 skills。将执行向下推入确定性工具。分发 skills。这就是整个系统。

## 这意味着什么

当实现成本接近零时，瓶颈转移。不再是"我们可以构建这个吗？" 而是"我们应该构建这个吗？"和"它到底应该做什么？"

品味、愿景和领域知识成为稀缺资源。深度理解呼叫筛选并编写精确配方的人比可以从头实现 Twilio 集成的人创造更多价值。配方就是实现。

这也意味着最好的 AI agent 设置默认将是开源的。封闭的、专有的 agent 配置正在与一个人发布配方并且一千个 agents 在一夜之间实现它的世界竞争。配方以 git push 的速度传播。护城河是品味，而不是代码。

软件分发重新构想：包是一个 markdown 文件，运行时是一个足够聪明的模型，包管理器是你的 AI agent，应用商店是一个 git 仓库。

`gbrain install voice-agent`

就这样。
