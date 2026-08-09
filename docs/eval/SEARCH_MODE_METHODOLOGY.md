# PMBrain 搜索模式评估方法

本文说明如何比较 `conservative`、`balanced` 和 `tokenmax`，是
《PMBrain 检索与 Dream 质量评测规范》的统计方法补充。不要复用上游 GBrain 的旧版本
数字作为 PMBrain 当前结论；每次结论都必须来自当前代码、固定数据集和保存的原始输出。

## 比较对象

同一次比较必须固定：

- 代码提交、数据库快照和 Source 范围；
- 查询集、相关性标注、随机种子和模型配置；
- Embedding、Reranker 的实际启用状态；
- 每个模式的 limit、token budget 和超时；
- 机器、数据库引擎与冷/热缓存条件。

只改变搜索模式。任何配置漂移都应标记该轮结果无效，不把模型或数据变化误报为模式收益。

## 必须记录的指标

- Recall@5：前五条是否召回标注相关结果；
- MRR：第一条相关结果出现的位置；
- 首条有效结果率：首条结果能否直接支持问题；
- 引用准确率：答案引用是否真的支持陈述；
- P50/P95 延迟；
- 返回块数和实际 token；
- `vector_enabled`、Reranker 是否执行及失败原因。

关键词、向量、标题、关系和 Reranker 的分项分数应尽量保留，方便定位是哪一层发生变化。

## 执行流程

```powershell
pmbrain eval run-all --seed 42
pmbrain eval compare --md
pmbrain eval compare --json
```

如果当前分支的参数与上面命令不同，以 `pmbrain eval --help` 为准。保存命令、退出码、
提交 SHA、配置摘要和原始 JSON；Markdown 报告只是展示层，不能替代原始结果。

## 判断规则

1. 对同一查询进行成对比较，不混合不同查询集的平均值。
2. 报告样本量和置信区间；小样本只写“观察到”，不写“证明提升”。
3. 多模式、多指标同时比较时进行多重比较校正。
4. 质量提升但延迟或 token 明显恶化时，单独列出成本，不合并成“整体通过”。
5. 一次未命中不代表资料不存在；先核对 Source，再用语义查询、精确关键词和原文页交叉验证。

完整产品验收要求见
[PMBrain 检索与 Dream 质量评测规范](PMBrain检索与Dream质量评测规范.md)。
