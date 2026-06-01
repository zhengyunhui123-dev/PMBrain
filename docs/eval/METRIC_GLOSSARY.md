# 评估指标词汇表

**自动从 `src/core/eval/metric-glossary.ts` 生成。请勿手动编辑。** 运行 `bun run scripts/generate-metric-glossary.ts` 重新生成。

`gbrain eval *` 和 `gbrain search stats` 报告的每个指标都在这里有一个 plain-English 解释。行业术语逐字保留，以便搜索文献的用户找到我们报告的内容。

## 检索指标

### Precision at k (P@k)

**键：** `precision@k`

**Plain English：** 引擎返回的前 k 个结果中，有多少比例是实际相关的？高精确率意味着列表顶部很少有垃圾结果。

**范围：** 0..1，越高越好。P@10 = 0.7 意味着前 10 个结果中有 7 个是相关主题。

### Recall at k (R@k)

**键：** `recall@k`

**Plain English：** 在 brain 中存在的所有相关结果中，引擎在其前 k 个中找到了多少比例？高召回率意味着很少错过答案。

**范围：** 0..1，越高越好。R@10 = 0.81 意味着每 100 个问题中有 81 个的正确答案在前 10 名中。

### Mean Reciprocal Rank (MRR)

**键：** `mrr`

**Plain English：** 平均而言，第一个相关结果在列表中向下多远？MRR 为 1.0 意味着第一次命中总是正确的；MRR 为 0.5 意味着它通常在排名 2。

**范围：** 0..1，越高越好。计算为所有测试查询的 1/第一个相关结果排名的平均值。

### Normalized Discounted Cumulative Gain at k (nDCG@k)

**键：** `ndcg@k`

**Plain English：** 类似于 precision@k，但引擎将好的结果放在顶部附近比放在排名 k 附近获得更多学分。完美的排序得分为 1.0；完全随机的排序得分接近 0。

**范围：** 0..1，越高越好。nDCG@10 高于 0.65 是技术语料库上混合检索的常见"发布它"阈值。

## 集合相似性 / 稳定性指标

### Jaccard similarity at k (set Jaccard @k)

**键：** `jaccard@k`

**Plain English：** 两个结果列表重叠多少？将捕获的基线中的前 k 个 slug 与当前运行进行比较；Jaccard@10 = 1.0 意味着完全一致，0.0 意味着零重叠。

**范围：** 0..1，越高 = 越稳定。在稳定的语料库上低于 0.5 意味着检索发生了显著变化。

### Top-1 stability rate

**键：** `top1_stability`

**Plain English：** 两次运行之间 #1 结果相同的查询比例。最激进的稳定性检查 — 不改变顶部答案的小排名变化不会伤害它。

**范围：** 0..1，越高 = 越稳定。高于 0.85 通常意味着检索更改可以安全合并。

## 统计显著性指标

### p-value (paired bootstrap)

**键：** `p_value`

**Plain English：** 两种模式之间观察到的差异仅由噪声引起的可能性有多大。越低 = 差异是真实证据越强。我们使用 10,000 次重采样和跨 12 个比较（3 种模式 × 4 个指标）的 Bonferroni 校正进行计算。

**范围：** 0..1，越低 = 信号越强。低于 0.05 是常见的"统计显著"阈值；低于 0.01 是强证据。

### 95% Confidence Interval (CI)

**键：** `confidence_interval`

**Plain English：** 给定我们测量的样本，我们有 95% 的把握真实值落在其中的范围。更窄的 CI = 更可靠的估计。通过 bootstrap 重采样计算。

**范围：** 两个元组 [low, high]。如果 Δ 的 CI 内包含 0，则差异在统计上不显著。

## 运营 / 成本指标

### Cache hit rate

**键：** `cache_hit_rate`

**Plain English：** 重用最近缓存的答案而不是运行新鲜的搜索比例。更高的命中率 = 更低的延迟 + 更低的 LLM 支出，但如果阈值太宽松，可能会滑过陈旧的结果。

**范围：** 0..1，通常越高越好。0.7-0.9 是繁忙 brain 的最佳位置；高于 0.9 可能表明相似性阈值太宽松。

### Average results returned

**键：** `avg_results`

**Plain English：** 引擎每次调用返回的平均搜索结果行数。应该接近活动模式的 searchLimit，除非 brain 很小或预算正在丢弃结果。

**范围：** 0..searchLimit。远低于 searchLimit 表明预算压力或稀疏检索。

### Average tokens delivered

**键：** `avg_tokens`

**Plain English：** 每次搜索调用返回的块文本中的估计 token（chars / 4）。agent 循环为每个搜索支付的上下文量的直接度量。

**范围：** 0..tokenBudget。近似于英语的 OpenAI tiktoken 计数；对于 Anthropic 偏离约 5-10%，对于非英语更差。

### Cost per query (USD)

**键：** `cost_per_query_usd`

**Plain English：** 一次搜索调用的 LLM + 嵌入 API 费用总和。包括 Haiku 扩展调用（仅 tokenmax 模式）+ 嵌入成本 + 如果测量的下游答案模型成本。

**范围：** 0..无界。Conservative 模式通常 <$0.001 每次调用；带有答案生成的 tokenmax 可以超过 $0.01。

### p99 latency (ms)

**键：** `p99_latency_ms`

**Plain English：** 每次搜索调用的第 99 百分位挂钟时间。1% 用户看到的延迟 — 长尾体验，而不是平均值。

**范围：** 0..无界。热缓存命中应该 <50ms；带有扩展的 tokenmax 可能由于 Haiku 调用而超过 200ms。

---

## 覆盖

任何 `gbrain eval *` 或 `gbrain search stats` 命令打印的每个指标都通过 `src/core/eval/metric-glossary.ts` 中的 `getMetricGloss()` 解析。向词汇表添加新指标需要更新此文档；CI 守卫捕获漂移。
