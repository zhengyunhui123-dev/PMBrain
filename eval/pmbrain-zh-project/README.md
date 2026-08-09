# PMBrain 中文项目知识库 Benchmark

这是一套不读取用户知识库的合成种子评测：20 个虚构项目、100 个固定中文问题，覆盖风险、承诺、日期、金额和决策五类项目管理检索。

运行：

```bash
bun run eval:pmbrain-zh-project
```

本地快速检查可设置 `PMBRAIN_BENCH_LIMIT=10`；默认值始终是完整的 100 问，CI/正式消融不得使用限量模式。

报告包含 Recall@5、MRR、正确文档命中率、首位命中率、引用正确率、平均延迟和 Token 消耗。当前 runner 不调用生成模型，所以 Token 为 0；后续接回答层时可复用 `scorePmbrainZhBenchmark` 写入真实引用和 Token。

该种子集用于阻止明显回归，不替代真实 PMBrain 私有语料上的人工标注 holdout。扩展算法默认值前，应同时提供合成集和私有 holdout 的消融证据。
