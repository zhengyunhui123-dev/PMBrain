# PMBrain 检索链

PMBrain 的检索不是单独的向量查询。修改搜索或 RAG 时，应沿下面的真实调用链检查，并使用
PMBrain 的固定评测文档验收。

## 当前流水线

```text
查询与 Source 范围
  → 中文查询规范化、别名和意图判断
  → 关键词检索 + 向量检索
  → RRF 融合与精确标题增强
  → 去重、关系召回和图信号
  → 可选 Reranker
  → 自适应截断与 Token 预算
  → 引用和证据标记
```

主要实现：

- `src/core/search/hybrid.ts`：主流水线；
- `keyword.ts`、`vector.ts`：两条基础召回臂；
- `query-normalize-zh.ts`、`alias-normalize.ts`、`title-match.ts`：中文、别名和标题；
- `relational-recall.ts`、`graph-signals.ts`：关系与图信号；
- `rerank.ts`：可选交叉编码重排；
- `autocut.ts`、`return-policy.ts`、`token-budget.ts`：返回范围；
- `evidence.ts`：证据标记；
- `src/core/operations.ts`、`src/commands/search.ts`：Operation 与 CLI 入口；
- `src/commands/admin-knowledge-search.ts`：Admin 直接检索入口。

## 三种模式

- `conservative`：精确与低成本优先，关闭扩展和专用 Reranker。
- `balanced`：默认综合模式，启用必要的图信号，但不要求额外生成式调用。
- `tokenmax`：召回上限优先，可启用查询扩展和已配置的 Reranker。

普通模型、Embedding 和 Reranker 是三类独立配置。未配置 Embedding 时，导入仍保留原文和
分块，检索继续使用关键词、标题和关系路径；不得自动选择或回退到其他向量模型。

## 验收

检索修改至少检查：

- 真实问题集的 Recall@5、MRR 和首条有效结果；
- 引用与 Source 是否正确；
- `vector_enabled`、Reranker 和模式开关是否实际执行；
- PGLite 与 Postgres 结果合同；
- 一次未命中时，是否用 Source、精确关键词和原文进行交叉验证。

固定入口：

- `docs/eval/PMBrain检索与Dream质量评测规范.md`
- `docs/eval/PMBrain与原版GBrain的检索和Dream功能对比.md`

上游 GBrain 只作为候选实现基线。引入上游检索改动前，必须逐项判断 PMBrain 的中文查询、
国内模型、多 Source、Desktop 和数据安全适配，不能整段覆盖。
