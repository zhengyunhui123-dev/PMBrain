# PMBrain 检索（RAG）与 Dream 质量评测规范

版本：1.0

维护日期：2026-07-28

这份文档是 PMBrain 后续检索与 Dream 优化的固定验收依据。目标不是只让某一个知识库“看起来更准”，而是用公开固定题集、用户真实题集和结构质量指标同时约束发布质量。

## 1. 配置契约

普通模式只要求两个模型：

1. 普通模型：`models.default`，兼容旧键 `chat_model`。RAG 查询扩展、回答生成、Dream、事实抽取和后台 Agent 在没有高级覆盖时都跟随它。
2. 向量模型：`embedding_model` 与固定维度。更换后必须重建向量。

高级模式可以单独覆盖 `utility`、`reasoning`、`deep`、`subagent` 四个任务层级，以及 Dream 的 `synthesize`、`synthesize_verdict`、`patterns`、`extract_atoms`、`synthesize_concepts`、`consolidate`、`conversation_facts_backfill` 等阶段。

高级模型属于可选优化。高级模型出现密钥错误、模型不存在、限流、网络故障或结构化拒答时，必须尝试普通模型。`balanced` 搜索不依赖 ZeroEntropy 或其他专用重排序器；云端或本地 reranker 只能显式启用。

## 2. 三层题集

| 层级 | 数量 | 用途 | 是否含私人内容 |
|---|---:|---|---|
| 公开固定题集 | 12 | CI、跨版本回归、所有用户共同基线 | 否 |
| 本地真实题集 | 30 起 | 检验用户真实措辞、中文长尾、来源隔离 | 是，仅保存在 `eval/private/` |
| 公共端到端题集 | LongMemEval 全量 | 检验检索加回答的跨会话记忆能力 | 否 |

公开固定题集位于 `test/fixtures/eval-baselines/qrels-search.json`。每题都有问题、相关页面、期望第一名、预计回答和答案判定条件。本地真实题集位于 `eval/private/pmbrain-real.qrels.json`，不得提交。

### 2.1 公开固定题集

| ID | 问题 | 预计回答重点 | 主要能力 |
|---|---|---|---|
| q1 | fintech founder building payments infrastructure | Alice Example、Widget Co、支付基础设施 | 实体与项目 |
| q2 | meeting notes from last quarter strategy session | 2026 Q1 策略会议、Charlie Example | 时间与会议 |
| q3 | AI safety research alignment work | Bob Example、AI safety、alignment | 语义改写 |
| q4 | Series A deal in healthcare vertical | Acme Example、医疗、Series A | 实体与交易 |
| q5 | distributed systems architecture postgres replication | 分布式系统、PostgreSQL replication | 技术概念 |
| q6 | weekly task list goals review | 周任务、个人目标、复盘 | 个人计划 |
| q7 | fund investor partner introduction | Dana Example、Fund A、介绍关系 | 关系检索 |
| q8 | design system component library | 设计系统、组件库 | 产品设计 |
| q9 | accelerator batch founder demo day | Elliot Example、加速器、Demo Day | 人物与事件 |
| q10 | TypeScript bun runtime build pipeline | TypeScript、Bun、构建链路 | 精确技术词 |
| q11 | retrieval augmented generation paper notes | RAG、检索综述、论文笔记 | RAG 概念 |
| q12 | founder mode product feedback loop | 优先 originals，concepts 为辅助 | 同名页消歧 |

### 2.2 本地真实题集规则

真实题集至少包含以下类别，每类不少于 3 题：

- 精确名称、文件名、代码名和中文专有词。
- 同义改写，不直接复述原文。
- 时间问题；事件日期必须来自正文，不能只看 `updated_at`。
- 关系和多跳问题。
- 同名页面、同名实体与跨 Source 隔离。
- 最近项目进展和完成状态。
- 原始资料与 Dream 派生页同时存在时的权威来源选择。
- 已知存在但曾经漏召回的困难问题。

一次搜索未命中只记为“检索未命中”，不能直接判定知识不存在。复核顺序为 Source、查询词、关键词搜索、原文页和引用。

## 3. RAG 指标与评分

每次运行必须保存逐题结果，不能只保存均值。

| 指标 | 权重 | 通过线 | 含义 |
|---|---:|---:|---|
| Hit@1 / First relevant hit | 25 | ≥ 0.70 | 第一条是否就是可用答案 |
| MRR | 20 | ≥ 0.70 | 第一条有效结果平均排位 |
| Recall@5 | 15 | ≥ 0.85 | 前 5 条是否覆盖正确页面 |
| Recall@10 | 10 | ≥ 0.90 | 前 10 条是否漏掉相关页面 |
| nDCG@10 | 10 | ≥ 0.80 | 多个相关结果的排序质量 |
| 引用准确率 | 10 | ≥ 0.95 | 回答事实能否被引用页支持 |
| Source 隔离准确率 | 5 | = 1.00 | 是否命中正确 Source 的同名页 |
| 稳定性与错误率 | 5 | 错误率 = 0 | 无空成功、超时静默或未声明降级 |

RAG 总分为各指标百分制得分乘权重之和。任何 `queries_errored > 0`、Source 隔离低于 100%，或引用准确率低于 90%，即使总分较高也不得标记为发布通过。

运行本地题集：

```powershell
bun src/cli.ts eval gate --qrels eval/private/pmbrain-real.qrels.json --json
```

运行公开固定门：

```powershell
bun test test/eval-replay-gate.test.ts
```

## 4. Dream 指标与评分

Dream 不能只统计“生成了多少页”。每次测试必须使用隔离的测试 Brain，或先创建数据库快照；不得在用户正式知识库上做破坏性实验。

| 指标 | 权重 | 通过线 | 判定方法 |
|---|---:|---:|---|
| 事实保真 | 25 | ≥ 0.95 | 输出事实可回溯到原对话或原文 |
| 证据关系有效率 | 20 | ≥ 0.95 | `derives_from`、`evidence_of` 能解析到真实页面 |
| 实体与概念串联率 | 15 | ≥ 0.80 | 新页进入人物、项目、概念或模式 Hub |
| 可连接孤儿率改善 | 15 | ≥ 30% | 排除原始资料、输出页、附件和临时页后比较 |
| 去重与合并质量 | 10 | ≥ 0.90 | 不重复制造同义概念页，不误合并跨 Source 同名实体 |
| Source 规则正确率 | 10 | = 1.00 | Source 内实体优先，default 回退，跨 Source 仅显式解析 |
| 可读性与行动价值 | 5 | ≥ 0.80 | 输出不是空泛摘要，能说明结论、证据和下一步 |

Dream 总分同样按权重计算。事实保真低于 90%、出现跨 Source 误合并，或覆盖原始资料时直接判定失败。

孤儿页统计必须只计算“应被连接的知识页”。`outputs/`、`raw/`、`originals/`、Youdao 原始镜像、附件、Dream 汇总页等不进入分母。历史关系回填前后要保存：

- 总页面数与可连接页面数。
- 可连接孤儿数和比例。
- 新增关系数，按关系类型分组。
- 无法解析的引用样例。
- 错误跨 Source 关系数。

## 5. 模型对比矩阵

每个候选模型都用同一题集、同一向量索引、同一搜索模式、同一 Prompt 和同一 Dream 输入运行。只改变一个模型变量。

| 组合 | 普通模型 | 高级覆盖 | 专用 reranker | 用途 |
|---|---|---|---|---|
| A 普通基线 | 单一普通模型 | 无 | 无 | 所有用户必须可用 |
| B 分层模型 | 同 A | utility/reasoning/deep/subagent | 无 | 衡量分层收益 |
| C Dream 分阶段 | 同 A | 只覆盖 Dream 阶段 | 无 | 衡量 Dream 质量收益 |
| D 专用重排 | 同 A | 无或同 B | 显式启用 | 衡量排序收益、延迟与隐私成本 |

模型综合建议分为两张表，不能把“搜索排序”和“回答写得好”混成一个分数：

1. RAG 分数：使用第 3 节指标。
2. Dream/回答模型分数：事实保真 30%、引用与归因 20%、结构化输出 15%、关系生成 15%、稳定性 10%、延迟 5%、成本 5%。

推荐规则：

- 普通模型：必须在无任何高级覆盖、无专用 reranker 时通过 RAG 与基础 Dream 门。
- 最大效果配置：只能推荐在相同语料和题集上稳定提升至少 3 分，且没有事实保真或 Source 隔离回归的组合。
- 分差小于 3 分时，优先推荐更稳定、便宜、配置更少的模型。
- 未实际运行的模型标记为“未测”，禁止根据名气补分。
- 单一模型自评只能作为参考；正式 Dream 评分至少需要两个独立判定模型或人工复核。

## 6. 运行记录模板

每次结果至少记录：

- PMBrain 版本与 Git commit。
- 测试日期、题集版本、题数、知识库 Source。
- 普通模型、各高级覆盖、向量模型、维度、搜索模式、reranker。
- 每项 RAG 与 Dream 指标、逐题失败、延迟、错误率和成本。
- 与上次基线的差值。
- 最终总分、是否通过、推荐配置与限制。

机器可读模板位于 `eval/templates/pmbrain-model-scorecard.example.json`。所有发布建议必须指向一份完成的结果文件。

## 7. 发布门

发布前至少满足：

1. 公开固定题集通过。
2. 本地真实题集通过，且没有已知存在内容被错误宣布为不存在。
3. 普通模式无高级密钥也能完成 RAG 与 Dream。
4. Dream 在隔离测试 Brain 上通过事实保真、关系有效率和 Source 规则。
5. 任何模型推荐都有相同题集的可追溯评分，不使用推测分。
