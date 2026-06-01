# 搜索模式评估方法论

_v0.32.3 如何测量 `conservative`、`balanced` 和 `tokenmax` 之间的差异。撰写时免疫仇恨者：每个声明都可以从提交的数据库 + 原始输出中重现。_

## 1. 它测量什么和不测量什么

**测量：** 在固定的公共数据集上，在每个命名的搜索模式下，针对相同的 brain 内容的检索质量和运营成本。

**不测量：**
- 你的特定 brain 内容（这是一个基准，不是你的账单）。
- 你的特定查询分布。
- 最终用户满意度或下游任务成功。
- 并发负载下的延迟。
- 生产成本（成本数字只是模型定价估计 × 数据集大小，不是你的实际 API 支出）。

如果你想知道一个模式在你的 brain 上的行为，在真实使用窗口后运行 `gbrain search stats --days 30`，然后运行 `gbrain search tune` 获取可操作的建议。

## 2. 数据集和大小

- **LongMemEval** — 公共拆分，`n=500` 问题。从 [Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval) 下载。语料库 + 答案密钥固定到特定提交；记录在每个每次运行记录中。
- **Replay captures** — 来自兄弟 `gbrain-evals` 仓库的 NDJSON，`n=200` 查询。每个查询携带一个 `retrieved_slugs` 基线 + 来自原始生产运行的 `latency_ms` 测量。
- **BrainBench v1** — `n=1240` 文档 / `n=350` qrels（二元相关性判断）。位于兄弟 [`gbrain-evals`](https://github.com/garrytan/gbrain-evals) 仓库中，每次运行都进行 SHA 固定。

任何报告结果中均未使用私有 brain 内容。`<repo>/.gbrain-evals/` 下的提交 NDJSON 转储仅包含 LongMemEval 问题 ID + 排名有序的检索会话 ID。

## 3. 样本选择

- **随机种子：** 全程为 `42`。通过 `gbrain eval run-all` 上的 `--seed N` 设置；记录在每个每次运行记录中。
- **无每问题策划。** 拆分整体获取；没有为报告过滤问题。
- **无模式特定调优。** 相同的数据集 + 相同的种子馈送每个模式。模式是唯一的自变量。
- **跨重新运行的稳定性：** 使用 `--seed 42` 和相同的数据集 SHA，相同（模式，套件）的两次运行产生相同的检索排序（模可选的非确定性 Haiku 扩展调用）。持久化在 `eval_results` 中，以便任何人都可以从提交的转储中重新评分。

## 4. 运行过程

命令就是文档。任何人都可以重现。

```bash
# 设置：在你的 gbrain 工作树中，导出了 OPENAI_API_KEY + ANTHROPIC_API_KEY。
git rev-parse HEAD  # 记录方法论页脚的代码

# 使用种子 42 扫描所有 3 种模式 × 2 个以检索为重点的套件。
gbrain eval run-all \
  --modes conservative,balanced,tokenmax \
  --suites longmemeval,replay \
  --seed 42 \
  --limit 500 \
  --budget-usd-retrieval 5 \
  --budget-usd-answer 20 \
  --output docs/eval/results/v0.32.3/

# 渲染比较。
gbrain eval compare --md > docs/eval/results/v0.32.3/README.md
gbrain eval compare --json > docs/eval/results/v0.32.3/comparison.json
```

编排器将每次运行记录写入 `<repo>/.gbrain-evals/eval-results.jsonl`。每个记录携带：`run_id`、`ran_at`、`suite`、`mode`、`commit`、`seed`、`limit`、`params`、`status`、`duration_ms`。`docs/eval/results/v0.32.3/` 下的转储携带原始问题级输出，以便审查者可以使用他们自己的指标实现重新评分。

## 5. 有效性威胁

诚实列表。我们命名什么会让批评者驳回数字。

- **LongMemEval 偏向英语 + 技术。** 问题具有软件工程和消费产品的风味。在富含非英语 / 非技术内容的 brain（写作、艺术史等）上的性能可能不同。
- **BrainBench 很小**（1240 个文档），相对于生产 brain（10K-100K 页面）。绝对分数不能预测你的命中率；模式之间的 _delta_ 可以。
- **char/4 token 启发式。** Token 预算执行和成本估计使用字符计数 / 4 启发式。对于使用 OpenAI tiktoken 系列的英语，准确度在约 5-10% 以内；对于 Voyage 更差（我们在聊天检索中不使用 Voyage，所以它不会使报告的数字产生偏差，但如果你使用，你的预算上限将是近似的）。
- **扩展的质量提升因查询分布而异。** 评估数据显示，与没有（即，几乎不可测量的提升）相比，使用 LLM 扩展的 LongMemEval 语料库的相对质量约为 97.6%。在更罕见的实体 / 更长尾的查询上，提升可能更大。我们报告我们测量的语料库；YMMV。
- **配对 bootstrap 假设问题级独立性。** 同一对话线程中的多跳问题不是独立的；bootstrap CI 比现实稍微紧一些。
- **每个基准的单个 brain 实例。** 基准为每个问题启动一个内存中的 PGLite。此处测量的缓存命中率不反映长时间运行的生产 brain 的缓存状态。

## 6. 每问题原始输出

每个报告的指标都可以从提交到 `docs/eval/results/v0.32.3/` 的 NDJSON 转储中重现。方法论页脚中的提交 SHA 固定代码版本。

**每模式示例：** 转储旁边的自动生成的 `README.md` 包括每模式的赢和输示例，由确定性规则选择：

- **赢：** 此模式的分数超过次优模式的最大边际的 3 个问题。
- **输：** 此模式的分数低于次优模式的最大边际的 3 个问题。

由分数增量选择，不是手动挑选的。README 记录了规则，以便批评者可以验证。

## 7. 预先注册的期望

在运行之前，我们期望：

1. **tokenmax 在 Recall@10 上赢得** 比 conservative 高出 5-15 个百分点。LLM 扩展 + 50 个结果上限有助于罕见实体的表面形式。
2. **conservative 在每查询成本上赢得** 比 tokenmax 高出 5-15 倍。没有 Haiku 扩展 + 紧密的 4K 预算上限 = 个位数美分的查询。
3. **balanced 在 Recall@10 上落在 tokenmax 的 3pp 内。** 意图加权（零 LLM 成本）在常见查询上关闭了大部分扩展差距。
4. **没有模式打破 nDCG@10 ≥ 0.65** — 技术语料库上混合检索的已发布"发布它"阈值。

然后我们发布数据是否同意。**如果假设失败，那就在发布 README 中诚实地记录**，而不是埋没。预先注册是使比较站得住脚的原因 — 没有它，"我们期望 X 并得到 X"的结果就是观察，而不是预测。

## 8. 重新运行节奏

每次触及影响检索的代码的发布都会重新生成此文档 + 评估结果。`gbrain doctor eval_drift` 检查显示在 `src/core/eval/drift-watch.ts` 中策划的手表列表的更改：

- `src/core/search/**`
- `src/core/embedding.ts`
- `src/core/chunkers/**`
- `src/core/ai/recipes/anthropic.ts`
- `src/core/ai/recipes/openai.ts`
- `src/core/operations.ts`

对手表列表的添加需要 CHANGELOG 行。

## 统计显著性纪律

当 `gbrain eval compare --md` 报告两种模式之间的 Δ 时，它计算：

- **配对 bootstrap**，每个指标有 10,000 次重采样。每个重采样绘制 _问题级_ 对（相同问题，模式 A vs 模式 B），因此问题级方差被差分掉。
- **跨 12 个比较的 Bonferroni 校正**（3 种模式 × 4 个指标）。报告的 p 值是比较的原始 p 值 × 12（钳位在 1.0）。
- **95% 置信区间** 从 bootstrap 分布计算。

如果 Δ 的 CI 包含 0 或 Bonferroni 调整的 p 值超过 0.05，则差异在统计上 **不** 显著。MD 报告逐字说"不显著"。

## 词汇表

报告打印的每个指标在 `docs/eval/METRIC_GLOSSARY.md` 中都有一个 plain-English 条目，从 `src/core/eval/metric-glossary.ts` 自动生成。CI 守卫在 `scripts/check-eval-glossary-fresh.sh` 处在每次测试运行时重新生成并与提交的文件进行差异比较；过时的文档会使构建失败。

## 成本锚点

`gbrain init` 的模式选择器提示和 CLAUDE.md `## Search Mode` 表都显示这些粗略的成本锚点。仔细研究数学，以便它们可以审计：

**变量：**
- `T` = 每次搜索结果块的平均 token。递归块器目标是 300 字 / 块 → ~400 个 token（英语，OpenAI tiktoken 近似）。
- `N` = 每次查询传递的块（受模式的 `searchLimit` 限制）。
- `R` = 下游模型输入率。Sonnet 4.6 = $3/M。Opus 4.7 = $5/M。Haiku 4.5 = $1/M。
- `Q` = 每月查询次数。

**每查询输入成本**（下游 agent 读取块）：

    cost_per_query = T × N × R

| 模式 | T (token) | N (块) | Sonnet ($3/M) | Opus ($5/M) | Haiku ($1/M) |
|---|---|---|---|---|---|
| conservative (4K 上限, 10 最大) | ~400 | 10（或如果预算命中则更少） | $0.012 | $0.020 | $0.004 |
| balanced (12K 上限, 25 最大) | ~400 | ~25 | $0.030 | $0.050 | $0.010 |
| tokenmax (无上限, 50 最大) | ~400 | ~50 | $0.060 | $0.100 | $0.020 |

**每月成本** (Q × 每查询)：

| 模式 @ Sonnet | 1K Q/mo | 10K Q/mo | 100K Q/mo |
|---|---|---|---|
| conservative | $12 | $120 | $1,200 |
| balanced | $30 | $300 | $3,000 |
| tokenmax | $60 | $600 | $6,000 |

| 模式 @ Opus | 1K Q/mo | 10K Q/mo | 100K Q/mo |
|---|---|---|---|
| conservative | $20 | $200 | $2,000 |
| balanced | $50 | $500 | $5,000 |
| tokenmax | $100 | $1,000 | $10,000 |

**gbrain 自己的成本** 在上面：

- 查询嵌入 (text-embedding-3-large @ $0.13/M tokens)：~$0.00001 每次查询。在每个规模都可以忽略不计。
- Tokenmax Haiku 扩展调用 ($1/M 输入, $5/M 输出, ~500 输入 + 200 输出每次调用)：~$0.0015 每次查询，或在 100K 查询时 $150/mo。缓存命中将此减半。
- 每页索引（一次性）：受你的导入量限制，而不是查询量。此处未建模。

**缓存命中调整。** 热 brain 通常在重复查询流量上看到 30-50% 的缓存命中。缓存命中完全跳过下游输入成本（缓存的结果已经在 agent 的上下文中一次）。所以现实世界的成本在繁忙的 brain 上运行约为上表的 50-70%。

**为什么这些数字与你的实际账单 DRIFT：**

- 你的 agent 的系统提示 + 推理 token 添加了 gbrain 看不到的输入。
- 压缩在长时间会话中减少输入。
- 大多数 agents 每轮进行 1-5 次搜索；按轮计费的是你，而不是按查询成本。
- 模型价格列随着提供者重新定价而漂移；通过 `src/core/anthropic-pricing.ts` 固定费率以获取当前快照。

选择器副本 + CLAUDE.md 表是规范的用户面向源。当底层块器大小或默认 `searchLimit` 更改时，同步更新它们。

## 模式 × 模型矩阵（25 倍传播）

上面的每查询数学假设 Sonnet 4.6 下游。在现实中，下游模型层是更大的成本杠杆。每次查询成本在 10K 查询/月（典型的单用户量），仅搜索负载（无缓存节省）：

| 模式 (搜索 token) | Haiku 4.5 ($1/M) | Sonnet 4.6 ($3/M) | Opus 4.7 ($5/M) |
|---|---|---|---|
| conservative (~4K) | **$40/mo** | $120/mo | $200/mo |
| balanced (~10K) | $100/mo | $300/mo | $500/mo |
| tokenmax (~20K) | $200/mo | $600/mo | **$1,000/mo** |

线性缩放：乘以 10 得到 100K/mo（重度 power user / 多用户舰队）；除以 10 得到 1K/mo（轻度使用）。

**自然配对跨越约 4 倍**（便宜模型 + 紧密模式 → 前沿模型 + 松散模式）。**不匹配浪费容量：**

- `tokenmax + Haiku`：Haiku 每次查询获得 20K 的搜索结果填充到它的上下文中。Haiku 的推理较弱；更多的块 = 更多的噪声，而不是更多的信号。你支付 Haiku 费率但获得亚 Haiku 质量。错误的方向。
- `conservative + Opus`：Opus 有 200K 上下文窗口，可以跨许多块进行综合。限制在 10 个块 / 4K token 使 Opus 的推理供应不足。你支付 Opus 费率但获得 conservative-shape 检索。浪费的支出。

**正确调整规则：** 将模式的 `searchLimit` 匹配到下游模型的"有用上下文深度"：

- Haiku 在 ~5-10 个跨引用内容块之外挣扎 → conservative
- Sonnet 处理 ~25-40 个块良好 → balanced
- Opus 从 50+ 个块中受益用于多跳推理 → tokenmax

## 现实规模锚点（单 power-user agent 循环）

上面的每查询数学是诚实的但是理论上的：它将每次搜索视为一个孤立的可计费事件。真正的 agent 循环通过 Anthropic 提示缓存在许多轮上分摊大量上下文。这是一个重度 power-user 循环在生产中的实际样子，匿名化 + 缩放，以便数字代表一个代表性的 power user 而不是任何特定的部署。

**参考形状 — 单用户规模的生产中的 tokenmax：**

| 数量 | 近似值 |
|---|---|
| 30 天总 agent 支出 | ~$700/mo |
| 30 天总 token 计费 | ~800M |
| 每月轮次 | ~860 (~29/天；一个活跃的 agent 循环) |
| 平均每轮 token | ~900K |
| 平均每轮成本 | ~$0.85 |
| Anthropic 提示缓存命中率 | ~88% |

这里的"轮"是一个 agent 循环迭代：读取用户消息、计划、执行工具调用（包括 gbrain 搜索）、生成响应。每轮通常包括 2-4 次 gbrain 搜索。

**从 tokenmax 锚点的每模式缩放：**

模式之间的成本差异集中在每轮成本的可归因于搜索的部分。系统提示、工具定义、对话历史和推理 token 不会随模式改变 — 只有 gbrain 传递的块会。假设每轮有 3 次搜索，使用模式的 `searchLimit`：

| 模式 | 每轮搜索 token | 每轮搜索成本 (at $3/M effective) | 每 860 轮的搜索可归因 @ | Δ vs tokenmax |
|---|---|---|---|---|
| tokenmax | ~60K (3 × 20K) | ~$0.18 | ~$155/mo | — |
| balanced | ~30K (3 × 10K) | ~$0.09 | ~$77/mo | -$78 |
| conservative | ~12K (3 × 4K) | ~$0.036 | ~$31/mo | -$124 |

**通过 NATURAL PAIRING 暗示的总 agent 支出**（模式 + 匹配的下游模型）。每轮成本随下游模型的每 token 率缩放，因为缓存的前缀 + 未缓存的部分 + 推理 token 都按该率计费：

| 配对 | 每轮成本 | 总计 @ 860 轮/mo |
|---|---|---|
| tokenmax + Opus (前沿, 最大质量) | ~$0.85 | ~$700/mo |
| balanced + Sonnet (最佳位置) | ~$0.50 | ~$430/mo |
| conservative + Haiku (成本敏感) | ~$0.20 | ~$170/mo |

**跨自然配对的 4 倍传播。** 模型层占主导地位，因为每 token 率适用于整个每轮负载（系统 + 工具 + 历史 + 推理 + 搜索），而不仅仅是 gbrain 的块。模式选择在此基础上贡献约 10-20%。

**不匹配的配对使你偏离曲线：**

| 配对 | 每轮估计 | 总计 @ 860 轮/mo | 与自然的比较 |
|---|---|---|---|
| tokenmax + Haiku | ~$0.20 | ~$170/mo | 与 conservative+Haiku 相同的成本，更差的质量 |
| conservative + Opus | ~$0.75 | ~$640/mo | tokenmax+Opus 支出的 92%，conservative-shape 检索 |

不匹配数学说：tokenmax+Haiku 用户支付与 conservative+Haiku 相同，但获得更嘈杂的上下文（Haiku 无法从 50 个块中过滤信号）。conservative+Opus 用户支付几乎与 tokenmax+Opus 相同，但在检索深度上使 Opus 饥饿。两者都燃烧预算而没有改进。

**这个锚点告诉我们的每查询数学没有的东西：**

1. **在具有严格提示缓存的现实 agent 循环规模上，模式选择节省总 agent 支出的 10-20%** — 有意义，但比每查询 5 倍比率暗示的要小。严格的提示缓存布局削弱了模式 delta，因为大部分每轮成本是缓存的前缀，而不是搜索负载。

2. **没有那种提示缓存纪律，每查询框架会重新断言自己。** 在每轮搅动提示前缀的设置（频繁的系统提示编辑、无模板的工具定义、无提示缓存结构化）看到搜索负载占总成本的更大比例。那些设置应该更多地关心模式选择，而不是更少。

3. **此处引用的缓存命中率（~88%）是可以实现的，但不是自动的。** 它需要将提示结构化，以便缓存的前缀在各轮之间保持稳定：系统提示 + 工具定义首先，历史压缩但缓存感知，检索的块最后附加（其中它们的波动性不会使前缀无效）。在缓存区域内交错搜索结果的 agents 在每轮都支付前缀重建税。

**此处堆叠的警告：**

- 锚点代表一个 power-user 循环。多用户舰队按比例聚合；每用户形状不会改变。
- "每轮 3 次搜索"的假设变化很大。代码审查 agent 可能每轮发出 10+ 次搜索；仅聊天的循环可能做 0。
- 88% 的缓存命中率是可以实现的高端。一半更接近没有缓存感知提示布局的默认 agent。
- "Δ vs tokenmax" 数学假设其他成本组件（系统、工具、历史、推理）保持恒定。在实践中，conservative 的更小的每轮负载也为历史在上下文窗口中留下更多空间 → 这可以以任一方向改变 agent 行为。

这个锚点 + 每查询数学都故意放在这个文档中。每查询框架是孤立的基准会测量的（以及 `gbrain eval run-all` 将产生的）。现实规模锚点是运营商实际支付的。两者都是诚实的；两者都不是全部真相。

## 可重现性页脚

每个发布评估数字都包含一个带有以下内容的页脚：

- 代码提交 SHA
- 数据集 SHA (LongMemEval, BrainBench, Replay)
- `--seed N`
- 逐字运行命令
- 使用的 API 模型标识符 (Anthropic + OpenAI + 判断模型)

没有这些，数字就是不可伪证的。有了它们，任何有 API 密钥的人都可以重新评分。
