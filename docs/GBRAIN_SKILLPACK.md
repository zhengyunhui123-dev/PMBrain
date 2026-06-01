<!-- skillpack-version: 0.7.0 -->
<!-- source: https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_SKILLPACK.md -->
# GBrain Skillpack：AI 代理的参考架构

这是生产级 AI 代理如何使用 gbrain 作为其知识骨干的参考架构。基于具有 14,700+ brain 文件、40+ 技能和 20+ cron 作业持续运行的真实部署模式。

**Memex 愿景，已实现。** Vannevar Bush 想象了一个设备，个人存储一切，机械化以便可以以超过速度的速度查阅。GBrain 就是那个设备，只不过 memex 自己构建自己。代理检测实体、丰富页面、创建交叉引用，并自动维护编译的真相。

下面的每个部分都是一个独立的指南。点击进入完整内容。

---

## 核心模式

基础读写循环和数据模型。

| 指南 | 涵盖内容 |
|-------|---------------|
| [Brain-Agent 循环](guides/brain-agent-loop.md) | 使 brain 随时间复合的读写周期 |
| [实体检测](guides/entity-detection.md) | 在每条消息上运行它。捕获原创想法 + 实体提及 |
| [Originals 文件夹](guides/originals-folder.md) | 捕获你的想法，而不仅仅是你发现的 |
| [Brain-First 查找](guides/brain-first-lookup.md) | 在调用任何外部 API 之前检查 brain |
| [编译的真相 + 时间线](guides/compiled-truth.md) | 线上方：当前综合。线下方：仅追加证据 |
| [来源归属](guides/source-attribution.md) | 每个事实都需要引用。格式和层次结构 |

## 数据管道

获取数据并保持最新。

| 指南 | 涵盖内容 |
|-------|---------------|
| [丰富管道](guides/enrichment-pipeline.md) | 7 步协议，层级系统（按重要性分 Tier1/2/3） |
| [会议摄取](guides/meeting-ingestion.md) | 始终拉取完整记录，传播到所有实体页面 |
| [内容和媒体摄取](guides/content-media.md) | YouTube、社交媒体包、PDF/文档 |
| [尽职调查摄取](guides/diligence-ingestion.md) | 数据室材料：推介资料包、财务模型、股权结构表 |
| [确定性收集器](guides/deterministic-collectors.md) | 用于数据的代码，用于判断的 LLM。收集器模式 |
| [想法捕获和 Originals](guides/idea-capture.md) | 深度测试、原创性分布、深度交叉链接 |
| [获取数据进入](integrations/README.md) | 集成配方：语音、电子邮件、X、日历 |

## 操作

运行生产级 brain。

| 指南 | 涵盖内容 |
|-------|---------------|
| [参考 Cron 计划](guides/cron-schedule.md) | 20+ 重复作业、安静时间、梦想周期 |
| [通过 Minions 的 Cron](../skills/conventions/cron-via-minions.md) | 为什么计划的工作作为 Minion 作业运行，而不是 `agentTurn`。由 v0.11.0 迁移为内置处理程序自动应用；特定于主机的处理程序使用下面的插件契约。 |
| [插件处理程序](guides/plugin-handlers.md) | 通过代码注册特定于主机的 Minion 处理程序（无数据文件 exec 表面）。 |
| [Minions 修复](guides/minions-fix.md) | 修复半迁移的 v0.11.0 安装。 |
| [Shell 作业 (v0.14.0+)](guides/minions-shell-jobs.md) | 将确定性 cron（API 获取、令牌刷新、抓取+写入）从 LLM 网关移开。每次触发零令牌，~60% 网关净空。遵循 `skills/migrations/v0.14.0.md` 以获取采用演练。 |
| [安静时间和时区](guides/quiet-hours.md) | 在睡眠期间保持通知，感知时区的传递 |
| [执行助理模式](guides/executive-assistant.md) | 电子邮件分类、会议准备、日程安排 |
| [操作纪律](guides/operational-disciplines.md) | 信号检测、brain-first、写入后同步、心跳、梦想周期 |
| [技能开发周期](guides/skill-development.md) | 5 步周期：构思、原型、评估、编目、cron |

**子代理路由 (v0.11.0+)：** 分派后台工作的代理应该通过 `skills/conventions/subagent-routing.md` 路由 — 它读取 `~/.gbrain/preferences.json#minion_mode` 并在原生子代理和 Minion 作业之间分支。v0.11.0 迁移自动将标记注入指向此约定的 AGENTS.md。

**Cron 路由 (v0.11.0+)：** 计划的工作通过 Minions 进行，而不是 OpenClaw 的 `agentTurn`。有关重写模式，请参见 `skills/conventions/cron-via-minions.md`。v0.11.0 迁移自动重写处理程序是 gbrain 内置的条目；特定于主机的处理程序（例如 `ea-inbox-sweep`）需要根据 `docs/guides/plugin-handlers.md` 进行代码级注册。

## 架构

如何构建你的系统。

| 指南 | 涵盖内容 |
|-------|---------------|
| [双仓库架构](guides/repo-architecture.md) | 代理仓库 vs brain 仓库、边界规则、决策树 |
| [子代理模型路由](guides/sub-agent-routing.md) | 哪个任务使用哪个模型、信号检测器模式、成本优化 |
| [三种搜索模式](guides/search-modes.md) | 关键字、混合、直接。何时使用每种模式 |
| [Brain vs 代理内存](guides/brain-vs-memory.md) | 3 层：GBrain（世界知识）、代理内存、会话 |

## 集成

连接你的生活。

| 指南 | 涵盖内容 |
|-------|---------------|
| [凭证网关](integrations/credential-gateway.md) | ClawVisor / Hermes 用于 Gmail、日历、联系人 |
| [会议和通话 Webhook](integrations/meeting-webhooks.md) | Circleback 记录 + Quo/OpenPhone SMS/通话 |
| [语音到 Brain](../recipes/twilio-voice-brain.md) | 电话通话 + WebRTC 浏览器通话创建 brain 页面。25 个生产模式：身份分离、竞标系统、对话计时、主动顾问、提示压缩、呼叫者路由、动态 VAD、实时日志记录、皮带和吊带事后通话 |
| [电子邮件到 Brain](../recipes/email-to-brain.md) | Gmail 消息通过确定性收集器流入实体页面 |
| [X 到 Brain](../recipes/x-to-brain.md) | Twitter 监控，带删除检测和参与度速度 |
| [日历到 Brain](../recipes/calendar-to-brain.md) | Google 日历事件变为可搜索的每日 brain 页面 |
| [会议同步](../recipes/meeting-sync.md) | Circleback 记录自动导入，带与会者传播 |

## 管理

保持运行并更新。

| 指南 | 涵盖内容 |
|-------|---------------|
| [升级和自动更新](guides/upgrades-auto-update.md) | check-update、代理通知、迁移文件 |
| [实时同步](guides/live-sync.md) | 保持索引最新：cron、--watch、webhook 方法 |

## 入门

设置后，brain 是空的。冷启动技能排序最高价值的数据源以填充它：

| 指南 | 涵盖内容 |
|-------|---------------|
| [冷启动](../skills/cold-start/SKILL.md) | 第一天引导：联系人、日历、电子邮件、对话、社交、档案。使用 ClawVisor 进行安全凭证处理 — 代理从不持有原始 API 密钥。 |
| [询问用户](../skills/ask-user/SKILL.md) | 决策点用于人工输入的选项门模式。由冷启动和其他技能使用。 |

---

## 附录：GBrain CLI 快速参考

| 命令 | 用途 |
|---------|---------|
| `gbrain search "term"` | 跨所有 brain 页面的关键字搜索 |
| `gbrain query "question"` | 混合搜索（向量 + 关键字 + RRF） |
| `gbrain get <slug>` | 通过 slug 读取特定的 brain 页面 |
| `gbrain sync` | 将本地 markdown 仓库同步到 gbrain 索引 |
| `gbrain import <path>` | 将文件导入 brain |
| `gbrain embed --stale` | 重新嵌入具有陈旧或缺失嵌入的页面 |
| `gbrain integrations` | 管理集成配方（感知 + 反射） |
| `gbrain stats` | 显示 brain 统计信息（页面计数、上次同步等） |
| `gbrain doctor` | 诊断 brain 健康问题 |
| `gbrain check-update` | 检查新版本和集成配方 |

运行 `gbrain --help` 获取完整的命令参考。

---

## 架构和哲学

- [基础设施层](architecture/infra-layer.md) — 导入管道、分块、嵌入、搜索
- [瘦工具包，胖技能](ethos/THIN_HARNESS_FAT_SKILLS.md) — 架构哲学
- [Markdown 技能作为配方](ethos/MARKDOWN_SKILLS_AS_RECIPES.md) — 为什么 markdown 是代码，而你的代理是包管理器
- [个人 AI 的家酿](designs/HOMEBREW_FOR_PERSONAL_AI.md) — 10 星愿景
- [推荐模式](GBRAIN_RECOMMENDED_SCHEMA.md) — 你的 brain 仓库的目录结构
- [验证运行手册](GBRAIN_VERIFY.md) — 端到端安装验证
