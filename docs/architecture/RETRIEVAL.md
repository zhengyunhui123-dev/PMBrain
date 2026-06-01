# 混合 + 图堆栈为何有效

单独的向量搜索在真实的个人知识查询上表现不足。本文档解释了 gbrain 为何将四种策略分层组合在一起，以及它们如何复合。

## 协同工作的四种策略

1. **向量 (HNSW on pgvector)** — 语义相似度。捕获"谁在 YC 从事检索质量工作？"→ 即使从未键入"YC"，也会提及"Garry Tan + retrieval"的页面。
2. **BM25 关键词** — 词汇匹配。捕获名称、精确短语、代码标识符，以及用户记住字面 token 的任何情况。在向量搜索漂移到主题邻居的情况下幸存下来。
3. **互惠排名融合 (RRF)** — 合并向量 + 关键词排名，而不全局加权一个胜过另一个。每个策略都可以投票。
4. **知识图谱遍历** — 遵循类型化边。通过遍历 `bob ── invested_in ──> company ── dated ──> Q1` 来捕获"Bob 本季度投资了什么？"。向量搜索看不到因果链；图谱可以。

## 为何每种单独都会失败

**仅向量。** 返回与查询语义接近的块。遗漏任何未直接在嵌入中编码的事实关系。"Garry 投资组合中的公司"返回关于投资组合的文章，而不是公司页面。

**仅关键词 (ripgrep 风格)。** 对措辞脆弱。"谁从事检索工作？"遗漏了说"搜索排名"而不是"retrieval"的页面。同义词、近似未命中或释义的垃圾。

**仅图谱。** 在"Alice 的邻居"方面表现出色，但对尚未链接的任何内容都视而不见。在反向链接累积之前，在新鲜页面上稀疏。

**混合（向量 + 关键词 + RRF），无图谱。** 在"X 是什么？"类型查询上表现不错。在"X 与 Y 的关系是什么？"上失败 — 那些是图谱查询，无论嵌入调整如何都无法恢复它们。

## 基准

BrainBench（兄弟仓库 [gbrain-evals](https://github.com/garrytan/gbrain-evals) 中的语料库 + 工具）在 240 页 Opus 生成的富散文语料库上测量检索 P@5、R@5、MRR、nDCG@5。

| 策略 | P@5 | R@5 | 说明 |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | 仅词汇基线 |
| vector-only RAG | ~18 | ~80 | 标准 RAG 实现 |
| gbrain graph-disabled (hybrid + RRF, no graph traversal) | ~18 | ~85 | 仅混合 |
| **gbrain default (full stack)** | **49.1** | **97.9** | 图谱 + 提取质量提升 |

从图谱 + 提取质量工作中获得 **+31 P@5 点**。图谱不是一个边缘特征；它是承重墙。

## 自动链接：零 LLM 调用边提取的工作原理

每个 `put_page` 都会在 markdown 正文上运行 `extractEntityRefs`。它匹配：

- 标准 markdown 链接：`[Garry Tan](wiki/people/garry-tan)`
- Obsidian wikilinks：`[[wiki/people/garry-tan|Garry Tan]]`
- 类型化链接块引用：`> **Convention:** see [path](path).`

三个正则表达式，零 LLM token，带有 `INSERT ... SELECT FROM unnest(...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` 的单个 SQL `addLinksBatch` 调用。图谱在每次写入时以接近零的成本增长。在 17K 页面大脑上，完整图谱提取在几秒钟内完成。

启发式链接类型推断（`attended`、`works_at`、`invested_in`、`founded`、`advises`）从周围的句子上下文触发 — 也是无 LLM 的。有权限的用户可以通过类型化链接块引用约定添加它们。

## ZeroEntropy 作为重排序器：60% top-1 重新洗牌

v0.36.0.0 发布 ZeroEntropy 的 `zerank-2` 作为默认重排序器（针对 `balanced` 模式捆绑包开启）。在跨 20 个查询的真实语料库基准上，zerank-2 在混合 + RRF + 图谱堆栈之后重新洗牌 **60% 的 top-1 结果**。这就是标题数字。

机械原因：混合排名在每个策略方面是局部最优的，但在全局方面是次优的。交叉编码器重排序器通过完整注意力共同读取查询 + 每个候选文档。它捕获向量 + 关键词 + 图谱信号都同意某个文档的情况，该文档在语义上相关，但在主题上是错误的。

成本：+150 毫秒 p50 延迟，约 $0.025/百万 token。使用 `gbrain config set search.reranker.enabled false` 禁用。对于在检索后执行下游 LLM 工作的代理循环，延迟是不可见的。

## 来源感知排名

混合搜索在 SQL 层应用来源因子 CASE 表达式（存在于 `src/core/search/sql-ranking.ts` 中）。策划的内容（如 `originals/`、`concepts/`、`writing/`）的排名高于批量内容（如 `your-openclaw/chat/`、`daily/`、`media/x/`）。硬排除前缀（`test/`、`archive/`、`attachments/`、`.raw/`）在检索时过滤，而不是在排名后过滤。

提升映射可通过 `GBRAIN_SOURCE_BOOST` 环境变量或每调用 `SearchOpts.exclude_slug_prefixes` 进行配置。临时查询（`detail: 'high'`）绕过提升，以便聊天页面重新显示在
对时间敏感的查找上。

## 意图感知查询重写

`src/core/search/intent.ts` 将查询分类为 `entity`、`temporal`、`event` 或 `general`。每个都通过不同的排名旋钮路由：

- **实体**查询（"谁在 X 工作？"）应用更高的图谱遍历权重。
- **临时**查询（"上周发生了什么？"）绕过来源提升，以便聊天/每日页面显示。
- **事件**查询（"Acme AI Series A"）使用时间线索引。
- **常规**查询命中标准混合堆栈。

分类器是确定性的（无 LLM 调用）。错误分类会优雅地降级 — 混合堆栈仍然可以在没有它的情况下工作。

## 多查询扩展

对于 `detail: 'high'` 搜索，`src/core/search/expansion.ts` 运行 Haiku 类 LLM 调用以生成 2-3 个查询变体。每个变体都通过完整混合堆栈运行；结果通过 RRF 合并。捕获同义词未命中，而不会丢失召回率。

扩展是按模式捆绑包选择加入的（`tokenmax` 默认开启；`balanced` + `conservative` 关闭）。在廉价层级中默认关闭，因为 LLM 调用会增加约 $0.001/查询和约 200 毫秒 — 规模上的真实资金。

## 综合起来

`query` 操作的完整管道：

```
意图分类
       │
       ▼
扩展（如果启用）
       │
       ▼
混合搜索：
   ├── 向量（块嵌入上的 HNSW）
   ├── 关键词（通过 tsvector 的 BM25）
   ├── 来源感知重新排名（SQL 中的 CASE）
   └── RRF 融合 → 前 30 个
       │
       ▼
图谱增强（来自任何种子的类型化边遍历）
       │
       ▼
重排序器（zerank-2 交叉编码器，前 30 → 重新排序）
       │
       ▼
token 预算强制执行（每模式捆绑包）
       │
       ▼
去重（相同的 slug，不同的块 → 保留最佳）
       │
       ▼
结果
```

每个阶段都可以隔离测试。每个阶段都是可替换的。整个管道的编排成本 < 1 毫秒；延迟预算用于上游 HTTP 调用（嵌入、重排序）和索引扫描。

## 如何在你自己的大脑上验证

```bash
# 运行公共 LongMemEval 基准
gbrain eval longmemeval datasets/longmemeval_s.jsonl

# 捕获你自己的查询并针对检索更改重放
export GBRAIN_CONTRIBUTOR_MODE=1
# ... 正常使用 gbrain ...
gbrain eval export > before.ndjson
# ... 更改某些内容 ...
gbrain eval replay --against before.ndjson

# 在标记的夹具上进行 A/B 检索策略
gbrain eval --qrels labels.tsv --config balanced.json
```

方法论 + 指标词汇表在 [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md) 中。
