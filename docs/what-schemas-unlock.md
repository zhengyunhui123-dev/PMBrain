# Schemas 解锁了什么

大多数笔记应用将每个页面视为相同的。您写一些东西，它进入一堆，您用文本匹配搜索这堆。标签有帮助，但标签是扁平的。几千页之后，这堆变得嘈杂，搜索变得愚蠢。

Schemas 是 gbrain 停止成为一堆笔记并变成有结构的东西的方式。Schema 声明了什么样的东西生活在您的 brain 中（`person`, `company`, `meeting`, `researcher`, `case`, `lab-result`），它们链接到什么（`attended`, `authored`, `prescribed-by`），系统应该自动提取什么事实（`mrr=50000`, `damages=5000000`），以及哪些类型通过专家搜索 vs 常规搜索路由。

默认 schema（`gbrain-base`）附带 22 个页面类型，涵盖通用形状 — people, companies, meetings, notes, daily, calendar events。这足以开始。但是您的 brain 是您的，并且您的 brain 的形状不是默认形状。研究 brain 需要 `researcher` 和 `paper` 作为一级类型。创始人 brain 需要 `lead`, `investor`, `portco`, `deal-stage`。律师 brain 需要 `case`, `motion`, `deposition`, `precedent`。相同的引擎，完全不同的形状。

v0.40.7.0 使 AGENTS 能够为您的 brain 编写该形状。不仅仅是"用户手动在 `~/.gbrain/schema-packs/mine/pack.yaml` 中编辑 YAML"，而是"您的代理看到语料库，提议一个类型，请求批准，以完整的审计跟踪原子地应用它，然后用一个分块的 SQL 命令回填 4000 个现有页面。"这就是新东西。

本文档是 WHY。[教程](schema-author-tutorial.md) 是 HOW。

## 杀手使用案例

### 1. 4000 个不可见页面

您在 `meetings/` 下有 4000 个 markdown 文件，可以追溯到两年前。默认 schema 没有 `meeting` 类型，因此所有 4000 个都被类型为 `note`（包罗万象）。当您运行时：

```bash
gbrain whoknows "Q3 roadmap discussion"
```

您获得前 10 个文本匹配，按原始相关性排名。Brain 不知道这些是会议。它无法路由到参会者。它无法提取日期。它无法呈现"三周后同一批人再次讨论了此对话。"

添加 `meeting` 类型：

```bash
gbrain schema add-type meeting --primitive temporal --prefix meetings/ --extractable
gbrain schema sync --apply
```

同步在所有 4000 个页面上以 1000 行为批回填 `page.type = 'meeting'`。现在：

- `gbrain whoknows "Q3 roadmap discussion"` 通过会议类型路由，按 `expert_routing` 信号（参会者，近期性，显著性）排名，而不是原始文本。
- `gbrain extract-facts` 自动在每个会议页面上运行（因为 `extractable: true`），提取类型化事实，如 `attended_by=alice-example`, `date=2026-05-23`。
- 下游 `think` skill 现在可以通过查询会议图形来回答"我们在过去三个路线图会议中关于定价决定了什么"，而不是 grep 4000 个文件。

一个命令。4000 个页面从不可见变为可查询。内容没有更改。结构更改了。

### 2. 创始人 ops brain

您是一位创始人或投资者，拥有约 500 个 markdown 文件，混合了 leads, portfolio companies, deal notes, intros 和 follow-ups。您一直自由写作；您没有系统。您的查询都是"等等，谁再次把我介绍给那个 fintech 创始人？"并且您滚动 Notion 20 分钟。

添加创始人形状：

```bash
gbrain schema fork gbrain-base mine
gbrain schema use mine

# 类型
gbrain schema add-type lead       --primitive entity --prefix people/leads/         --expert
gbrain schema add-type investor   --primitive entity --prefix people/investors/     --expert --extractable
gbrain schema add-type portco     --primitive entity --prefix companies/portco/     --expert --extractable
gbrain schema add-type deal       --primitive entity --prefix companies/deals/      --extractable

# 链接动词
gbrain schema add-link-type invested-in --page-type investor --target-type portco
gbrain schema add-link-type intro-from  --page-type lead     --target-type lead
gbrain schema add-link-type passed-on   --page-type investor --target-type deal
gbrain schema add-link-type led-by      --page-type deal     --target-type investor

gbrain schema sync --apply
```

现在 `gbrain whoknows "Series A SaaS"` 专门通过 `investor` 和 `portco` 类型路由，而不是嘈杂的通用类型集。`gbrain graph-query alice-example --type intro-from --depth 2` 遍历两跳介绍以呈现"Alice 将您介绍给 Bob，Bob 将您介绍给 Charlie。" `gbrain extract-facts` 开始从您的 deal 页面围栏中产生类型化声明：`(deals/acme-seed, raise=2000000, valuation=15000000, lead=widget-vc, closed_at=2026-05-23)`。

您一直承诺下个季度要设置的 CRM？您刚刚用 4 个命令发布了它。它位于您的笔记下游，而不是与它们并行。

### 3. 研究 brain

将"创始人"替换为"PhD student"，相同的模式适用于不同的类型：`researcher`, `paper`, `lab`, `grant`, `dataset` + `authored`, `cites`, `funded-by`, `uses-dataset`。

```bash
gbrain schema add-type paper --primitive annotation --prefix research/papers/ --extractable
gbrain schema add-link-type authored   --page-type researcher --target-type paper
gbrain schema add-link-type cites      --page-type paper      --target-type paper
gbrain schema add-link-type uses       --page-type paper      --target-type dataset
```

突然间"向我展示引用此工作并使用相同数据集的论文"是 `gbrain graph-query` 遍历，而不是 Google Scholar 中的 30 分钟。事实提取会自动获取 `arxiv_id=2402.04253`, `cited_by_count=140`, `published_date=2026-02-15`。您作为 markdown 的阅读列表变成了一个可查询的研究图形，它知道谁在做什么以及什么与什么相连。

### 4. 法律 brain（或任何声明具有数字的领域）

律师，医疗提供者，会计师，任何在领域中工作的人，其中数字的含义取决于其类型。"$5M 判决"对抗"$2M 案件策略阈值"是 brain 可以做出的比较 — 但仅当两个数字都被类型化时。

```bash
gbrain schema add-type case --primitive entity --prefix legal/cases/ --extractable --expert
gbrain schema add-type motion --primitive annotation --prefix legal/motions/ --extractable
gbrain schema add-type deposition --primitive annotation --prefix legal/depositions/ --extractable
gbrain schema add-link-type filed-in --page-type motion --target-type case
gbrain schema add-link-type cites    --page-type motion --target-type precedent
```

现在您案例笔记中的 `## Facts` 围栏可以携带类型化声明（`damages=5000000`, `filed_date=2026-05-23`, `judge=jane-doe`），gbrain 作为一级列存储。`gbrain eval trajectory legal/cases/acme-v-widget` 打印带有回归标记的案件历史。`gbrain founder scorecard`（为法律重命名：汇总原告成功率，平均损害赔偿，和解 vs 审判比率）为您提供了您实践表现的结构化视图。

没有类型化页面种类，这是不可能的。您可以在任何笔记应用中写相同的散文。只有 gbrain 将数字视为跨相同类型页面可比较。

### 5. 团队 brain

`gbrain mounts add` 允许您将额外的 brains 叠加在您的个人 brain 旁边。每个挂载的 brain 都有自己的 schema pack。工程团队的 brain 具有 `incident`, `runbook`, `service`, `oncall-rotation`。设计团队的 brain 具有 `component`, `experiment`, `ab-test`, `figma-link`。法律团队的 brain 具有 cases 和 depositions。

当您查询时，schema pack 管理每个源的内容路由方式。针对挂载的工程 brain 的工程查询知道 `incidents/2026-05-23-db-outage.md` 是一个具有 `severity=p0`, `mttr=47min`, `on_call=alice-example` 的 `incident` 页面 — 可提取的类型化事实。您针对相同 brain 的个人查询仍然有效，但路由更锐利，因为工程团队投入了他们的本体论。

Schema 是团队的文化知识显式化。不同团队的两名工程师搜索相同的 brain 会获得不同的路由，因为他们的个人 packs 声明了不同的专家类型。

### 6. "代理共同策展您的本体论"模式（新东西）

这就是 v0.40.7.0 实际启用的东西，以及已关闭的 PR #1321 所追求的。

您的 OpenClaw（或任何通过具有 admin 范围的 HTTPS MCP 连接到您的 brain 的代理）观察您的摄取流。在您将笔记转储到 `garrytan/companies/yc-w24/` 下一周后，代理定期运行 `gbrain schema detect`，看到该前缀正在累积，并提议：

> 您在 `companies/yc-w24/` 下有 47 个页面，类型为 `company`（通用）。它们共享一个结构模式（创始人姓名，筹集金额，批次标签）。我应该添加一个具有 `extractable: true` 的 `yc-w24-company` 类型，以及指向 `company` 的现有别名吗？我会回填 47 个页面，并从每个页面提取 `cohort=W24` 作为类型化事实。

您批准一次。代理通过 MCP 调用 `schema_apply_mutations`，使用一个批次：

```json
{
  "pack": "mine",
  "mutations": [
    {"op": "add_type", "name": "yc-w24-company", "primitive": "entity", "prefix": "companies/yc-w24/", "extractable": true, "expert_routing": true},
    {"op": "add_alias", "type": "yc-w24-company", "alias": "company"}
  ]
}
```

全部在 ONE `withPackLock` 范围内，原子地，审计（代理的 `client_id` 作为 `actor: mcp:<clientId8>` 捕获在审计日志中）。缓存跨进程失效。同步回填 47 个页面。Brain 学会了一类新的东西，而您无需考虑它。

下次您查询"YC W24 companies in fintech"时，brain 通过新类型路由。六个月后，当您完全忘记该模式时，代理会提醒您它在那里，并提供将其与 W25 批次合并。

Brain 学习。代理是策展人。您批准，代理完成工作。

### 7. 前 vs 后基准测试

如果您想在不购买推销的情况下感受差异：

选择一个您拥有的真实语料库。在应该匹配的主题上运行 `gbrain whoknows`。注意前 3 个结果。

然后运行 `gbrain schema review-orphans --limit 50 --json` 并查看未类型化的页面。如果其中 10+ 个共享一个应该是真实类型的明显前缀，请添加该类型 + 同步。

重新运行相同的 `whoknows` 查询。前 3 名应该改变，因为新类型现在通过专家排名路由，而不是被归入包罗万象。数值增量就是胜利。您可以在 5 分钟内运行一个教程；这个实验证明了它对您的实际内容很重要。

## 为什么这很重要

gbrain 做的三件事是通用笔记系统无法做的：

**1. Brain 知道 person 和 idea 之间的区别。** 页面类型在查询时很重要。`gbrain whoknows` 只考虑 `expert_routing: true` 类型。`gbrain extract-facts` 只在 `extractable: true` 类型上运行。`gbrain graph-query` 遍历声明的链接动词。这些在扁平标签系统中都不工作，因为标签没有语义 — 它们是标签。类型是具有附加规则的一级公民。

**2. 未类型化的内容是不可见的内容。** 如果您的会议类型为 `note`，专家路由会跳过它们，事实提取会忽略它们，链接推理不会触发。它们存在于磁盘上，并且它们被索引用于文本搜索，但结构化表面（whoknows, find_experts, recall, think）将它们视为二等公民。添加类型不是装饰性的；它是结构化提升。

**3. Schema 是可查询的 AND 可变的 AND 可审计的。** 您可以询问 brain 其 schema 是什么样的（`gbrain schema graph`），通过 14 个原子 CLI 动词 + 9 个 MCP 操作演变它，具有完整的锁 + 审计语义，并从任何错误中恢复（每个原语都有一个逆操作，加上 `gbrain schema downgrade` 恢复先前的活动 pack）。这不是"基于 vibes 的知识管理。" 这是一个具有结构性完整性保证的生产系统。

## v0.40.7.0 中具体更改了什么

v0.39.1.0 发布了 schema-pack 引擎。您已经可以 fork 捆绑的 pack 并手动编辑 `pack.yaml`。您不能做的是让代理安全地编写它 — 没有原子文件锁，没有审计日志，没有 MCP 暴露，查询路径中没有 pack 感知布线。Cathedral 已建成，但无法从外部访问。

v0.40.7.0 关闭了这些差距：

- **`withMutation` 骨架** 将每个原语包装在 8 个有序的安全步骤中（捆绑保护 → 锁 → 读取 → 变异 → 验证 → 原子写入 → 审计 → 失效）。磁盘上的 pack 文件永远不会是部分的。两个并发代理无法竞争。
- **每 pack `O_CREAT|O_EXCL` 原子锁**（不是来自 page-lock.ts 的 TOCTOU `existsSync+writeFileSync` 模式 — codex 在计划审查期间捕获了这一点）。变异运行时每 10 秒刷新一次 TTL；`--force` 意味着"窃取陈旧锁"，而不是"跳过锁定"。
- **隐私编辑的审计日志** 在 `~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl`。类型名称 sha8 哈希，前缀仅截断到第一段。审计的泄漏屏幕截图无法显示敏感分类法，如 `personal/oncology/` 或 `legal/depositions/`。
- **9 个新的 MCP 操作** 包括批处理的 `schema_apply_mutations`（admin 范围，不是 localOnly — 您的 OpenClaw 和任何远程代理通过正常的 HTTPS MCP 编写 packs，其中 `client_id` 作为 `actor: mcp:<clientId8>` 捕获）。
- **T1.5 布线** 最终为 `whoknows` 和 `find_experts` 完成：标记为 `--expert` 的自定义 `researcher` 类型现在实际出现在查询结果中。在 v0.40.7 之前，它静默地从不匹配，因为查询路径读取硬编码的 `['person', 'company']`。
- **跨进程失效** 通过 `loadActivePack` 内的 stat-mtime TTL 门控。操作员从终端运行 `gbrain schema add-type`；自动巡逻守护程序在 1 秒内获取新类型，无需重启。

累积效果：代理可以安全地共同策展您的本体论，并带有完整的取证跟踪。这就是新东西。

## 从哪里开始

- **想在 5 分钟内看到它工作？** 运行[教程](schema-author-tutorial.md)。Fork 捆绑的 pack，添加 researcher 类型，端到端证明布线。
- **想要代理配方？** 阅读 [`skills/schema-author/SKILL.md`](../skills/schema-author/SKILL.md)。代理在检测 schema 演变机会时遵循的 7 阶段工作流。
- **想要经验法则？** 阅读 [`skills/conventions/schema-evolution.md`](../skills/conventions/schema-evolution.md)。何时添加类型 vs 别名 vs 前缀的决策树。<20 页不要 pack 编码。100+ 页需要一级类型。
- **想要架构？** `CLAUDE.md` 中的"Schema Cathedral v3 (v0.40.7.0)"部分具有 14 个项目的逐模块细分，每个都引用了激励它的设计决策和 codex 发现。
- **想设置一个共同策展您 brain 的代理？** 运行 `gbrain auth register-client my-agent --scopes admin` 以铸造您的远程代理可以用来通过 MCP 调用 `schema_apply_mutations` 的 OAuth 客户端。然后，代理以其自己的节奏运行 detect → suggest → apply，并请您批准实质性更改。

杀手功能不是"schemas"。个人知识系统永远都有 schemas。杀手功能是您的代理可以代表您安全地塑造它们，具有您对数据库期望的结构性完整性保证，而不是笔记应用。

这就是我们构建的。在您实际拥有的语料库上尝试它，数字会上升。
