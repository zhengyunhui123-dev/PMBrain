# 透镜包（v0.41.2.0）

四个捆绑的 schema 包，将 gbrain 梦想循环转变为多透镜
大脑。使用 `gbrain config set schema_pack <name>` 激活一个，循环
会在下一次 `gbrain dream` 运行时接收包的声明阶段。

## 四个包

```
                gbrain-base (v0.38 发布)
                       ▲
                       │ 扩展
        ┌──────────────┼──────────────────────┐
        │              │                       │
   gbrain-creator  gbrain-investor      gbrain-engineer
   (atom + concept  (deal/thesis/        (learning bridge
    lifecycle)       bet_resolution)      for gstack)
        │              │                       │
        └──────────────┼───────────────────────┘
                       │ 扩展 + 借用链
                       ▼
              gbrain-everything (元包)
              one brain, three lenses active
```

### gbrain-creator

Atom + 概念内容创建者生命周期。驱动两个循环阶段：

- `extract_atoms` — 每个来源，Haiku 从每个
  脚本中提取 1-3 个 atom，使用封闭的 11 值 `atom_type` 枚举（insight、
  anecdote、quote、framework、statistic、story_angle、strategy_angle、
  strategy、endorsement、critique、collection）。写入
  `atoms/{YYYY-MM-DD}/{slug}` 页面。预算上限 $0.30/来源/运行。
- `synthesize_concepts` — 按 frontmatter 全局聚合 atom
  `concepts:` 引用。按计数分层：T1 ≥10、T2 ≥5、T3 ≥2。T1/T2 获取
  Sonnet 叙述；T3 回退到确定性存根。写入
  `concepts/{slug}` 页面。预算上限 $1.50/运行。

一个校准域：`concept_themes` / cluster_summary / [concept]
— 分层直方图 + 页面计数，而不是 Brier（概念没有二元
结果可以对其进行评分）。

### gbrain-investor

YC / 投资者透镜。在
gbrain-base 的 deal/person/company/yc seed 之上声明 2 个全新页面类型：

- `thesis` (NEW) — 带有 thesis_text + key_bets[] +
  market_view + vintage 的投资论文。存储在 `investing/theses/{slug}` 中。可提取
  （LLM 将主张挖掘到事实中）。
- `bet_resolution_log` (NEW) — 论文的 bet 的结果记录。通过 take_id 的 FK 连接到 take 行；携带 resolved_outcome + resolved_at +
  learned_pattern。存储在 `investing/bets/{YYYY-MM}/{slug}` 中。

没有新的循环阶段 — 使用现有的
extract_facts/propose_takes/grade_takes/calibration_profile 循环。三个
校准域：`deal_success`（针对附加到 deal 的
takes 的 scalar_brier）、`founder_evaluation`（针对附加到 person 的 takes 的
scalar_brier）、`market_call`（针对附加到 thesis 的 takes 的 weighted_brier；通过
conviction 进行加权，因此高置信度未命中成本更高）。

### gbrain-engineer

仅桥接包。声明 `learning` 页面类型 + 重用基础 `code`。
没有新的循环阶段 — 守护程序端的 `gstack-learnings` IngestionSource
(T8) 监视 `~/.gstack/projects/{repo}/learnings.jsonl` 并在
此包处于活动状态时将每个 JSONL 行作为 `learning`
页面发出。三个校准域：`architecture_calls` (scalar_brier)、
`effort_estimates` (weighted_brier)、`risk_assessment` (scalar_brier)。

推测性 ADR/postmortem/refactor_thesis/tech_debt 类型推迟到
v0.42+ — 它们将在第一个真实用户创作第一个时发布 (D8)。

### gbrain-everything

元包堆叠 creator + investor + engineer，通过 v0.38
`extends` + `borrow_from` 链。单活动包约束
保留 — 这是活动包；注册表遍历 extends +
borrow 以实现合并视图。

通过 `gbrain config set schema_pack gbrain-everything` 激活，并且
calibration_profile 在一个 JSONB 中生成所有 7 个域记分卡。

## 校准配置文件拓宽 (T10)

在 v0.41.2.0 之前，`calibration_profiles.domain_scorecards` 是
`JSON.stringify({})` 占位符。v0.41.2.0 拓宽了它：每个声明的
域都会生成一个 `{n, brier, accuracy, aggregator, page_types,
extras}` 条目。四种聚合器算法（封闭枚举）：

- **scalar_brier** — `AVG(POWER(weight - outcome::int, 2))`。默认用于
  概率预测。
- **weighted_brier** — 由 `ABS(weight - 0.5) * 2` 加权的 Brier
  （conviction 代理）。高置信度未命中成本更高。
- **count_based** — 简单的 `SUM(hit) / COUNT(*)` 准确率，不带
  Brier。当概率不自然时使用。
- **cluster_summary** — 描述性汇总（页面计数 + 分层
  直方图）。用于没有
  二元结果的域，例如 `concept_themes`。

包清单使用 `{name, aggregator, page_types}` 声明域。
域名是开放的（第三方包可以声明新的域标签
而无需 gbrain 发布）。聚合器算法是封闭的（安全 SQL
保留在代码中，在包加载时验证）。

## take_domain_assignments 表 (T11)

新 JOIN 表（迁移 v94）：
`take_domain_assignments(take_id BIGINT FK, domain TEXT, pack TEXT,
source TEXT, confidence REAL, assigned_at TIMESTAMPTZ, PK(take_id,
domain))`。多域分配诚实 — 关于"红杉对 Anthropic 的
投资"的主张可以同时落在 BOTH `deal_success` AND
`market_call` 中，而不是被强制放入一个存储桶。

## 这为用户启用了什么

- **Atom + 概念在二进制文件中发布**。你的 OpenClaw 的并行
  atom-pipeline-coordinator + atom-backfill-coordinator + concept-
  synthesis crons 可以退役 (T12 后续)。一个 `gbrain dream` cron
  覆盖所有内容。
- **gstack 学习到达 gbrain。** 工程师包激活的大脑
  在写入后几秒钟内将每个 gstack 记录的学习作为可查询页面
  显示。
- **多透镜校准。** 激活 gbrain-everything 并查看
  你在 deals AND 市场调用 AND 架构
  AND 努力估计方面经常出错的频率，只需一次 `gbrain calibration --json` 调用。
- **无损失 OpenClaw 迁移。** `markdown-greenfield`
  导入器 (T7, mode='migration') 使用永久 slug 键幂等性 + 每行 JSONL 审计
  + `imported_from` 标记重新摄取现有 OpenClaw
  页面，以便 extract_atoms + synthesize_concepts
  不会重新提取已经原子化的材料。

## v0.41.2.1 后续（在计划中归档）

- 页面类型 `frontmatter_validators` 上的 Per-page-type，以便
  atom_type 枚举（当前在 extract_atoms.ts 中硬编码）在运行时根据 D11 从
  活动包清单读取。
- 3-check 质量门（truism / punchline / entity-page reject）作为
  多通道 extract_atoms 优化。
- synthesize_concepts 中的嵌入相似度去重（当前
  仅限精确字符串概念引用匹配）。
- T1 Canon 叙述的语音门集成。
- op_checkpoint 在两个阶段中
  继续的跨循环延续。
- 针对你的 OpenClaw 现有 13K atom +
  11K 概念的奇偶校验基线评估门，在 500 页样本子集上。
