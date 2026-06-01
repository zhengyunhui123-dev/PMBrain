# gbrain eval suspected-contradictions (v0.32.6)

矛盾探测器对检索结果进行采样，询问 LLM 判断器是否有任何一对在与所述用户查询相关的事实主张上存在矛盾，并聚合为校准报告。输出是数据 — 操作员决定对什么采取行动。本文档涵盖了架构、严重性评分标准、如何解释标题数字以及何时采取行动。

## 为什么存在这个功能

gbrain 通过 compiled-truth-plus-timeline 和 source-boost 处理*策展*页面的矛盾：当 `companies/acme.md` 说 MRR 是 $2M，而 2024 年的聊天记录说 MRR 是 $50K 时，策展页面排名高于聊天。`takes.active` 过滤隐藏显式废弃的 takes。时间衰减使排名偏向于每个来源层级中更新的内容。

这些机制都没有测量：未标记语义矛盾实际在检索中出现的频率是多少？没有探测器，每个"我们是否应该构建更大的 swing（chunk 级 `revises` 字段 + 排名变化）"决定都是感觉。探测器产生证据。

## 架构

```
        ┌──────────────────────────────────────┐
        │ gbrain eval suspected-contradictions │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ 对于每个查询：hybridSearch top-K   │
        │ → cross_slug_chunks + intra_page     │
        │   chunk-vs-take 对                │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ 日期预过滤：跳过日期相差 >30 天的对   │
        │ （Codex 修复：同段落双日期覆盖）  │
        └──────────────────┬───────────────────┘
                           │
        ┌──────────────────▼───────────────────┐
        │ 持久缓存查找              │
        │ (chunk_a_hash, chunk_b_hash, model,  │
        │  prompt_version, truncation_policy)  │
        └────────┬─────────┬────────────────────┘
              hit│         │miss
                 │         ▼
                 │   ┌─────────────────────────┐
                 │   │ LLM 判断器调用          │
                 │   │ → JudgeVerdict          │
                 │   │ 置信度下限 ≥ 0.7  │
                 │   └─────────┬───────────────┘
                 │             │
                 ▼             ▼
        ┌──────────────────────────────────────┐
        │ 聚合每查询 + 全局统计   │
        │ Wilson 95% CI 在标题 %          │
        │ 来源层级分解                │
        │ 热门页面 + 解决提案     │
        └──────────────────┬───────────────────┘
                           │
                           ▼
                  ProbeReport JSON
                           │
        ┌──────────────────┼──────────────────────┬───────────────┐
        ▼                  ▼                      ▼               ▼
   doctor (M1)         MCP (M3)             synthesize (M2)   trend (M5)
   表面化           find_contradictions    信息块  持久
   发现           agent 的操作        在提示中    跟踪
```

## 严重性评分标准

判断器为每个发现分配严重性：

| 级别 | 评分标准 | 示例 |
|---|---|---|
| `low` | 命名/格式差异 | "Alice Smith" vs "A. Smith" |
| `medium` | 可能过时的事实值 | 收入数字、员工数、估值 |
| `high` | 身份 / 结构主张 | 创始人/CEO/CFO 角色、公司状态 |

Doctor 按严重性 DESC 排序发现。MCP 操作接受严重性过滤器，因此 agents 只能获取高优先级项目。

## 如何解释标题数字

探测器输出 `queries_with_contradiction / queries_evaluated`，带有 Wilson 95% 置信区间：

```
至少有 1 个矛盾的查询：12 / 50 (24%)  Wilson CI 95%: 14–37%
```

这意味着：有 95% 的信心，真实比率在 14% 和 37% 之间。24% 点估计是最可能的值，但受采样噪声限制。**当 n < 30 时触发 `small_sample_note`** — 在这个规模下，CI 太宽，无法采取行动。

更大 swing（chunk 级 `revises` 字段）的决策标准：

| Wilson CI 下限 | 说明什么 | 行动 |
|---|---|---|
| < 5% | Source-boost + 时间衰减 + 策展页面处理负载 | 停在这里；这是正确的范围 |
| 5–15% | 真实但有界 | 操作员决定成本是否证明 swing 的合理性 |
| > 15% | 真实且实质 | 在 v0.34+ 中计划更大的 swing |

## 何时对发现采取行动

每个发现都附带一个 `resolution_command` 字段 — 可粘贴就绪：

- `gbrain takes supersede <slug> --row N` — 更新的 take 应该替换同一页面上的旧 chunk 文本（intra_page 类型）。
- `gbrain dream --phase synthesize --slug <slug>` — 策展实体的 compiled_truth 需要更新（cross_slug 策展 vs 批量）。
- `gbrain takes mark-debate <slug> --row N` — 故意的分歧（例如，你想保留两者的两个意见）。
- `# manual review: <a> vs <b>` — 判断器不确定；操作员决定。

运行 `gbrain eval suspected-contradictions review --severity high` 以在不重新运行探测器的情况下检查发现。

## 成本模型

默认判断器是 `claude-haiku-4-5`，约 $1/Mtok 输入，$5/Mtok 输出。在 v0.32.6 中，每对截断为 1500 字符，每次判断器调用约 500 输入 + 80 输出令牌。预算上限在 TTY 默认为 $5，非 TTY 为 $1。

- 每次判断器调用约 $0.0006
- 每个查询约 $0.005（在日期预过滤 + 缓存命中后）
- 每 100 个查询约 $0.50

持久缓存意味着针对相同查询集的夜间运行在重新运行时支付接近零的费用（直到你提升 PROMPT_VERSION）。

## 信任姿态

- 探测器从不改变 brain。只运行读取页面/takes/chunks。写入只进入 `eval_contradictions_runs` 和 `eval_contradictions_cache`。
- MCP `find_contradictions` 是读取范围。不在 subagent 允许列表中 — 仅用户发起，不是自主操作表面。
- 构建夹具脚本仅本地。redactor + `isCleanForCommit` 门使得意外的私有数据提交变得困难，但操作员必须在提交前检查每个编辑。

## 另请参阅

- 计划：`~/.claude/plans/system-instruction-you-are-working-hashed-dewdrop.md`
- CHANGELOG：`## [0.32.6]` 条目涵盖整个版本。
- 成本纪律：`docs/eval-bench.md` 用于推荐的夜间节奏 + 趋势跟踪工作流。
- **时间轴后续（v0.35.3.1 + v0.35.7）：** v0.35.3.1 添加了一个六成员裁决枚举（`no_contradiction | contradiction | temporal_supersession | temporal_regression | temporal_evolution | negation_artifact`），并将 `pages.effective_date` 线程化到判断器提示中，因此探测器停止对合法的时间变化误报。v0.35.7 落地了探测器指向的轨迹基底：`gbrain eval trajectory <entity>` 显示带内联标记回归的按时间顺序类型化主张历史；`gbrain founder scorecard <entity>` 将四个信号（准确性、一致性、增长方向、危险信号）汇总为稳定的 JSON 契约。MCP 操作 `find_trajectory`（读取范围，对远程调用者可见性过滤）向 agents 公开相同数据。探测器的 `temporal_supersession` 裁决和 consolidate 阶段的 `valid_until` 回写都保留了 `auto-supersession.ts:4` 的"NEVER auto-applies"不变量 — 探测器仍然发出可粘贴的命令，只有 `consolidate` 写入 `valid_until`（R1+R8 grep 守卫固定这个）。
