# 针对你的 gbrain 更改运行真实世界评估基准

受众：gbrain 维护者和贡献者。如果你正在触及检索（搜索、排名、嵌入、意图分类、查询扩展、来源提升、混合融合），这就是文档。

关于 gbrain-evals 使用的 **NDJSON 线格式**，请参阅 [`eval-capture.md`](./eval-capture.md)。本文档是位于该格式之上的开发者循环。

## v0.41 更新 — 循环现在是真实的

在 v0.41 之前，你可以捕获评估行并重放它们，但没有什么将它们缝合成一个门控。`gbrain bench publish` + `gbrain eval gate` 关闭了循环。两个门控：

- **回归门控** (`--baseline X.baseline.ndjson`)：重放你针对当前大脑捕获的基线。捕获："我的重构是否破坏了搜索？" 比较 Jaccard / top-1 稳定性 / 延迟乘数。
- **正确性门控** (`--qrels Y.qrels.json`)：通过裸 `hybridSearch` 针对你的当前大脑运行已知正确的查询。捕获："我的检索实际上有多好？" 计算 recall@K、first-relevant-hit-rate、expected_top1-hit-rate。

两者可以一起传递；两者都必须通过才能获得 `pass` 判定。至少需要一个。

### 你自己大脑的完整循环

```bash
# 1. 捕获（一次性；使用 eval_candidates 中已有的查询）
gbrain eval export --limit 200 --tool query > /tmp/captured.ndjson

# 2. 发布基线
mkdir -p ~/.gbrain/baselines
gbrain bench publish --from /tmp/captured.ndjson --to ~/.gbrain/baselines/personal.baseline.ndjson --label "personal-$(date +%Y%m%d)"

# 3. 针对它进行门控
gbrain eval gate --baseline ~/.gbrain/baselines/personal.baseline.ndjson
```

### 隐私立场 (D9)

**`gbrain-evals` 中的公共基线仅是密闭合成的。** 真实用户捕获保留在本地 `~/.gbrain/baselines/` 中。边界在文件来源处强制执行，而不是通过事后清理。如果你将基线发布到 `gbrain-evals`，请从固定装置植入的测试大脑生成它（占位符名称如 `alice-example`、`widget-co-example`）— 永远不要从真实用户的 `eval_candidates` 表生成。

### 确定性管道披露

`gbrain eval gate --qrels` 使用裸 `hybridSearch`（不是生产 `query` 操作处理程序）。这是故意的：门控需要在 CI 中具有确定性。生产检索通过查询缓存、显著性新鲜度、扩展等不同。门控使用固定管道测量检索质量；当缓存预热时，你的用户可能会看到不同的结果。

### `.qrels.json` 形状

每个条目有两种等效表示：

```json
{
  "schema_version": 1,
  "queries": [
    {
      "query_id": "q1",
      "query": "fintech founder",
      "relevant_slugs": ["people/alice-example"],
      "first_relevant_slug": "people/alice-example"
    }
  ]
}
```

对于联合/多来源大脑，使用显式形状（不默认为 `source_id='default'`）：

```json
{
  "query_id": "q2",
  "query": "anything",
  "relevant": [
    {"source_id": "host", "slug": "people/alice"},
    {"source_id": "team-a", "slug": "people/alice"}
  ],
  "expected_top1": {"source_id": "host", "slug": "people/alice"}
}
```

没有 `source_id`，来自错误来源的命中可能会虚假通过门控。比较无处不在的是 `${source_id}::${slug}` 字符串。

### 示例 GitHub Actions 工作流

```yaml
name: gbrain-eval-gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: |
          # 运行两个门控；CI 在任何违反时失败。
          gbrain eval gate \
            --baseline gbrain-evals/baselines/v0.41-launch.baseline.ndjson \
            --qrels gbrain-evals/qrels/v0.41-launch.qrels.json \
            --json | tee /tmp/gate.json
```

---

## 先决条件：打开贡献者模式

捕获默认对生产用户**关闭**（隐私友好 — 无意外数据累积）。贡献者通过一行命令打开它：

```bash
# 在 ~/.zshrc 或 ~/.bashrc 中：
export GBRAIN_CONTRIBUTOR_MODE=1
```

验证：

```bash
gbrain query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'   # 应该 > 0
```

要覆盖（无论环境变量如何都强制打开/关闭），编辑 `~/.gbrain/config.json`：

```json
{"eval": {"capture": true}}    // 强制打开
{"eval": {"capture": false}}   // 强制关闭
```

显式配置在两个方向上都优于环境变量。

## 4 命令循环

```bash
# ① 捕获：每当设置 CONTRIBUTOR_MODE 时写入 eval_candidates。
#   检查已收集的内容：
gbrain doctor                                     # 显示捕获失败
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'

# ② 快照：在代码更改之前冻结基线。
gbrain eval export --since 7d > baseline.ndjson

# ③ 代码更改：做任何你想做的 — 调整 RRF_K、交换嵌入模型、编辑
#    hybrid.ts、添加新的提升来源、更改意图分类器。

# ④ 重放：针对当前构建重新运行每个捕获的查询。
gbrain eval replay --against baseline.ndjson
```

输出：

```
Replaying 247 captured queries…
  ...25/247
  ...50/247
  ...
Replayed 247 of 247 captured queries (0 skipped, 0 errored)
Mean Jaccard@k:    0.927
Top-1 stability:   91.5%
Mean latency Δ:    +14ms (current vs captured)

Top 5 regression(s):
  jaccard=0.20  captured=12  current=3   "find every reference to widget-co"
  jaccard=0.43  captured=14  current=8   "show me everything tagged for review"
  jaccard=0.50  captured=8   current=4   "what did alice say about the spec"
  ...
```

三个数字告诉你更改是否安全落地：

| 指标 | 含义 | 健康范围 |
|---|---|---|
| **Mean Jaccard@k** | 捕获的检索 slug 与当前运行的 slug 之间的平均重叠。1.0 = 相同集合。 | 对于"中性"更改 ≥0.85。<0.7 意味着重大检索移位。 |
| **Top-1 stability** | #1 结果未更改的查询比例。 | 对于调优通过 ≥85%。<70% 意味着漏斗顶部被破坏。 |
| **Mean latency Δ** | 当前减去捕获的。正数 = 现在更慢。 | 在捕获的 ±50ms 范围内。>2× 任何地方 = 回归警报。 |

## 它实际做什么

`gbrain eval replay` 读取你的 NDJSON 快照，并对每一行：

1. 重新执行相同的操作（`tool_name='search'` 的 `searchKeyword`，`tool_name='query'` 的 `hybridSearch`），并将捕获的 `detail` 和 `expand_enabled` 值穿回。
2. 捕获当前的 `retrieved_slugs`（去重，按结果顺序）。
3. 计算捕获和当前 slug 集之间的集合 Jaccard。
4. 记录 top-1 匹配（#1 结果是否是相同的 slug？）。
5. 记录与捕获的 `latency_ms` 的延迟增量。

它**不**计算 MRR 或 nDCG — 那些需要真实相关性标签，而不是基线比较。对于针对真实情况的指标评估，使用 `gbrain eval --qrels <path>`（传统 IR 评估路径，仍受支持）。重放工具回答不同的问题："我的代码更改是否移动了检索，以及它移动最多的查询是哪些？"

对于第三个评估轴 — 公共基准、真实标签、完整问题-答案管道（不仅仅是检索）— `gbrain eval longmemeval <dataset.jsonl>` (v0.28.8) 针对 gbrain 的混合检索运行 LongMemEval 基准。每个问题都会获得一个干净的内存中 PGLite，导入其干草堆，提出问题，假设作为 JSONL 发出 — 正是 LongMemEval 的 `evaluate_qa.py` 使用的形状。你的 `~/.gbrain` 大脑永远不会被打开。请参阅下面的 `## 公共基准：LongMemEval`。

## 设计上尽力而为

重放不是纯的。捕获和重放之间有三件事可能会漂移：

1. **大脑状态** — 你的大脑现在可能比拍摄快照时拥有更多页面。除非你明确植入固定语料库，否则平均 Jaccard 将仅因为新页面符合条件而下降。
2. **嵌入来源** — 如果你在捕获和重放之间更改了 `OPENAI_API_KEY`（或者嵌入模型轮换了），即使代码相同，向量路径结果也会漂移。
3. **捕获上限** — 捕获的 `retrieved_slugs` 是去重的集合；它不保留内部排名元数据。两个工具可以返回相同的 slug 集但分数不同 — Jaccard 会说 1.0，但按分数排序的下游消费者可能表现不同。

指标是**真实查询上的回归警报**，而不是哈希检查。将它们与顶级回归的手动检查配对。

## 成本

快照中的每一行 `query` 都通过 OpenAI 嵌入查询字符串以运行 `hybridSearch` 的向量一半。成本与正常的 `gbrain query` 调用相同 — OpenAI 列表价格的 text-embedding-3-large，在单个重放行中批量处理。

如果你在本地迭代并且不想为每个更改付费，请使用 `--limit 50` 来限制重放的行。最近的 50 行通常足以捕捉方向；在最终合并前运行扩展。

```bash
# 迭代模式 — 最近 50 个查询
gbrain eval replay --against baseline.ndjson --limit 50

# 合并前 — 完整快照
gbrain eval replay --against baseline.ndjson --top-regressions 20
```

## CI 集成

```bash
gbrain eval replay --against baseline.ndjson --json > replay.json
jq -e '.summary.mean_jaccard >= 0.85' replay.json || exit 1
jq -e '.summary.top1_stability_rate >= 0.85' replay.json || exit 1
```

稳定的 JSON 形状（schema_version: 1）：

```json
{
  "schema_version": 1,
  "summary": {
    "rows_total": 247,
    "rows_replayed": 247,
    "rows_skipped": 0,
    "rows_errored": 0,
    "mean_jaccard": 0.927,
    "top1_stability_rate": 0.915,
    "mean_latency_delta_ms": 14,
    "rows_over_2x_latency": 0
  }
}
```

`--verbose` 添加一个 `results: [...]` 数组，每个重放行有一个条目（对于通过管道传输到 jq 或笔记本进行更深入分析很有用）。

## 何时运行此

在合并触及以下内容之前：

- `src/core/search/hybrid.ts`（RRF、融合、去重、两遍检索）
- `src/core/search/source-boost.ts` / `sql-ranking.ts`（每来源排名）
- `src/core/search/intent.ts`（自动详情分类）
- `src/core/search/expansion.ts`（Haiku 查询扩展）
- `src/core/search/dedup.ts`（跨页面结果折叠）
- `src/core/embedding.ts` 或任何嵌入模型交换
- `src/core/operations.ts` `query` 或 `search` 操作处理程序（捕获表面）
- `src/core/postgres-engine.ts` / `pglite-engine.ts` `searchKeyword` / `searchVector` SQL

跳过：仅模式迁移、文档更改、仅测试 PR、不触及检索的 CLI 人体工程学

## 构建你自己的语料库

如果你还没有捕获的流量（全新安装，无法在合并前试用一周），你可以手动编写 NDJSON 文件：

```jsonl
{"schema_version":1,"id":1,"tool_name":"query","query":"who is alice","retrieved_slugs":["people/alice","people/alice-bio"],"expand_enabled":false,"detail":null,"latency_ms":0,"remote":false}
{"schema_version":1,"id":2,"tool_name":"search","query":"acme deal","retrieved_slugs":["deals/acme-seed","companies/acme"],"latency_ms":0,"remote":false}
```

然后运行 `gbrain eval replay --against handcrafted.ndjson` 以确认权威 slug 返回。这是 BrainBench-Real 管道（针对实时捕获重放）和 BrainBench 固定装置管道（`gbrain eval --qrels` 与兄弟 [gbrain-evals](https://github.com/garrytan/gbrain-evals) 语料库）之间的接缝。

## 关闭开关

两种禁用捕获的方法：

```bash
unset GBRAIN_CONTRIBUTOR_MODE             # 简单：只需取消设置环境变量
```

或通过 `~/.gbrain/config.json` 强制关闭（无论环境变量如何）：

```json
{"eval": {"capture": false}}
```

现有的 `eval_candidates` 行会保留，直到你 `gbrain eval prune --older-than 0d`（或者直接删除表）。

## 失败模式

| 你看到的内容 | 含义 |
|---|---|
| `Mean Jaccard@k: 0.4`，顶级回归都在一个来源目录中 | 该前缀的来源提升或硬排除回归 |
| `Top-1 stability: 30%`，平均 Jaccard 仍然很高 | RRF 调优改变了排名顺序而没有改变集合 — 重新调优 `rrfK` |
| `Mean latency Δ: +500ms`，jaccard 高 | 向量路径变慢；检查嵌入 API 或 HNSW 探测 |
| `rows_errored > 0` | 一个或多个查询抛出异常。检查人类输出中的前 3 个，或者 `--json` 查看所有 `error_message` 字段 |
| 许多 `skipped: empty query` | 捕获在有人传递空 `query` 的行上运行 — 检查这些为什么被捕获 |

## 公共基准：LongMemEval (v0.28.8)

`gbrain eval longmemeval` 直接针对 gbrain 的混合检索运行公共 [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) 基准。与 `eval replay` 不同的评估轴：带有真实标签的公共数据集、端到端问题-答案管道、密闭的每问题大脑。

```bash
# 下载数据集（在浏览器中访问 HF 页面；受控/手动下载）。
# 将 longmemeval_oracle.json（或 _s.json）放在本地某处。

# 仅检索（无 LLM 答案生成，最快路径，不需要 Anthropic 密钥）：
gbrain eval longmemeval ./longmemeval_oracle.json --limit 50 --retrieval-only \
  > /tmp/hypothesis.jsonl

# 完整管道（答案生成需要 Anthropic 密钥）：
gbrain eval longmemeval ./longmemeval_oracle.json --limit 50 \
  > /tmp/hypothesis.jsonl

# 使用 LongMemEval 发布的 evaluate_qa.py 评分（不捆绑 — 需要
# 按照其规范的 OpenAI gpt-4o）：
python evaluate_qa.py /tmp/hypothesis.jsonl
```

### 架构（如果你正在触及线束，请阅读此内容）

- 每个基准运行一个内存中 PGLite，通过 `createBenchmarkBrain` + `withBenchmarkBrain`。你的 `~/.gbrain` 永远不会被打开。
- 问题之间：`TRUNCATE` 超过运行时枚举的 `pg_tables`，而不是硬编码列表 — 模式迁移不会静默跨问题泄漏数据。基础设施表（`sources`、`config`、`gbrain_cycle_locks`、`subagent_rate_leases`）在重置之间保留。
- 清理对等：重新使用 `src/core/think/sanitize.ts` 中的 `INJECTION_PATTERNS`，因此添加新的注入模式自动覆盖 takes 和基准。单一事实来源。
- 检索到的聊天内容包裹在 `<chat_session id="..." date="...">` 框架中；答案生成系统提示声明内容 UNTRUSTED。与 `<take>` 框架相同的立场。
- LLM 注入接缝：`runEvalLongMemEval(args, {client?: ThinkLLMClient})`。测试存根客户端，因此完整管道在没有任何 API 密钥的情况下密闭运行。

### 标志

| 标志 | 默认 | 目的 |
|---|---|---|
| `--limit N` | 运行全部 | 限制问题数量（快速迭代） |
| `--retrieval-only` | 关闭 | 发出检索块；无 LLM 答案生成 |
| `--keyword-only` | 关闭 | 禁用向量路径（调试检索问题） |
| `--expansion` | **关闭** | 多查询扩展。默认关闭以确保确定性（无每查询 Haiku 调用）。传递以选择加入。 |
| `--top-k K` | 10 | 检索深度 |
| `--model M` | 已解析 | 默认通过 `resolveModel()` 6 层链解析（`models.eval.longmemeval` 配置键） |
| `--output FILE` | stdout | 将假设 JSONL 写入文件而不是 stdout |

### 数字

在 Apple Silicon 上，p50 25.9ms / p99 30.3ms 预热重置+导入+搜索（根据 `test/eval-longmemeval.test.ts` 性能门控）。每问题成本远低于 500ms 速度门控。500 个问题 = ~13s 开销加上你的检索和 LLM 延迟。

## 测量大脑一致性随时间变化 (v0.32.6)

`gbrain eval suspected-contradictions` 是一个补充测量工具：它对检索结果进行采样以查找未标记的语义矛盾（例如，compiled_truth vs 聊天内容，页内块 vs 活跃 take）。LongMemEval 在固定标记集上测量检索正确性，而矛盾探测测量真实大脑表面冲突答案的频率。

### 推荐的每晚节奏

```bash
# 每天一次，针对你的前 50 个最频繁查询：
gbrain eval suspected-contradictions \
  --queries-file ~/.gbrain/queries.jsonl \
  --top-k 5 \
  --budget-usd 5 \
  --output ~/.gbrain/probe-runs/$(date +%Y-%m-%d).json
```

持久缓存（`eval_contradictions_cache`）使重新运行成本接近零，直到你增加 `PROMPT_VERSION`。通过以下方式跟踪趋势：

```bash
gbrain eval suspected-contradictions trend --days 30
```

ASCII 条形图显示每天标记的总数。标题 % 出现在 `gbrain doctor` 的 `contradictions` 检查中，每个高严重性发现都有可粘贴的解决方案命令。

### 另请参阅

- `docs/contradictions.md` — 架构、严重性量规、行动标准。
- CHANGELOG `## [0.32.6]` — 完整的发行说明，包括受 Wilson CI 下限限制的更大摆动决策标准。

## v0.40.1.0 Track D — 评估基础设施

三个评估表面在 v0.40.1.0 中获得了非平凡能力。本节涵盖了使用它们的开发者循环和它们强制执行的门控。

### `gbrain eval longmemeval --by-type` — 每问题类型 R@k 细分

LongMemEval 一直内部计算每问题类型召回；v0.40.1.0 以机器可读的形式将其表面化。两个附加更改：

1. 现在每个每问题 JSONL 行都包含一个 `question: string` 字段，因此 `gbrain eval cross-modal --batch` 消费者（ below）可以在不加入源数据集的情况下读取它。
2. 新的 `--by-type` 标志发出由 `question_type` 键控的最终聚合行：

```json
{"schema_version": 1, "kind": "by_type_summary",
 "recall_by_type": {"single-session-user": {"hit": 18, "total": 19, "rate": 0.947}},
 "aggregate": {"hit": 110, "total": 120, "rate": 0.917}}
```

**可恢复安全。** 当 `--resume-from` 与 `--output` 是同一路径时，摘要从文件重建（每个每行都包括 `question_type` 和 `recall_hit`），因此最终聚合覆盖所有恢复的问题，而不仅仅是本次运行的切片。文件尾部的先前摘要被替换，而不是附加 — 一个在 500 问题运行中恢复 5 次的大脑在尾部恰好以一个摘要结束。

**可选门控。** `--by-type-floor 0.85` 在任何 `question_type` 的比率低于 0.85 时以非零退出。默认：仅信息性。

```bash
# 在搜索触及的更改后诊断每类型排名质量。
gbrain eval longmemeval ~/datasets/longmemeval_s.jsonl \
  --by-type --output /tmp/run.jsonl
tail -1 /tmp/run.jsonl | jq .   # 摘要行

# CI 脚本中的严格门控。
gbrain eval longmemeval test/fixtures/longmemeval-mini.jsonl \
  --by-type --by-type-floor 0.80 --output /tmp/run.jsonl
echo "exit=$?"  # 如果任何类型低于 0.80 则为 1
```

### 密闭检索门控 — `test/eval-replay-gate.test.ts`

v0.40.1.0 Track D 对"触及 `src/core/search/` 的 PR 静默回归检索"的结构性修复。取代了原始的"针对捕获的 eval_candidates 重放"设计（Codex 在 CI 中捕获为功能性 — 请参阅 `TODOS.md` 中的 `v0.41+: contributor-mode CI capture` TODO 以了解延迟的真实查询版本）。

工作原理：
- 手工策划的 qrels 固定装置位于 `test/fixtures/eval-baselines/qrels-search.json`，仅包含占位符名称（根据 CLAUDE.md 隐私规则，无真实人员/公司）。
- 测试用合成页面植入 PGLite 引擎，其嵌入是基础向量（与 `test/e2e/search-quality.test.ts` 相同的 `basisEmbedding(idx)` 模式）。无 API 密钥，无 DATABASE_URL。
- 对于每个 qrels 查询，调用 `engine.searchVector(basisEmbedding(dim))` 并计算 `top1_match_rate` 和 `recall@10`。断言两者都满足下限（默认情况下分别为 `>= 0.80` 和 `>= 0.85`）。
- 位于单元测试矩阵 (`.github/workflows/test.yml`) 中，因此它通过 `bun test` 在每个 PR 上运行，而不是在 E2E 固定文件工作流中运行。

#### 刷新 qrels 固定装置（the `Why:` discipline, D4）

当 CI 失败因为合法的排名更改移动了预期的 slug 时，修复方法是直接编辑 `qrels-search.json`。**始终在提交正文中包含 `Why:` 行**，以便未来的维护者可以读取审计跟踪。没有 `Why:`，门控会在几个月内退化为橡皮图章。约定是信息性的（不是提交钩子块），但在 PR 审查中强制执行它。

示例提交正文：

```
chore(eval): refresh qrels for new source-boost ordering

Why: v0.40.x source-boost now weights originals/ over concepts/, so
q12 (founder-mode) now correctly surfaces originals/founder-mode-example
top-1. Manual verification: ran the production query; new ranking is
clearly better-aligned with the query intent.
```

####  floors 的环境覆盖

```bash
GBRAIN_REPLAY_GATE_TOP1_FLOOR=0.85 \
GBRAIN_REPLAY_GATE_RECALL_FLOOR=0.90 \
  bun test test/eval-replay-gate.test.ts
```

用于随着 qrels 固定装置成熟而收紧或放松门控。

### `gbrain eval cross-modal --batch` — 批量质量评分

单任务跨模态评估对一个（任务，输出）对评分。批量模式在整个 LongMemEval JSONL 输出上运行相同的评分，带有成本护栏。

```bash
# 步骤 1：生成 LongMemEval 假设（真实成本：取决于模型 + N）。
gbrain eval longmemeval ~/datasets/longmemeval_s.jsonl \
  --limit 10 --output /tmp/run.jsonl

# 步骤 2：批量评分这些假设（真实成本：10 个问题约 $0.70，
# 1 个周期，默认 --max-usd 5 预算上限的 3 个模型槽）。
gbrain eval cross-modal --batch /tmp/run.jsonl \
  --limit 10 --cycles 1 --concurrent 3 --max-usd 5 --json
echo "exit=$?"  # 0=all-pass, 1=any-fail, 2=any-error-or-inconclusive
```

**关键行为：**
- 批量模式下默认 `--cycles 1`（单任务默认在 TTY 中为 3）以限制成本。传递 `--cycles 3` 以匹配单任务严格性。
- `--concurrent 3` 最多并行运行 3 个问题 x 每个 3 个模型槽 = 9 个同时 API 调用。低于所有三个提供商的 tier-1 速率限制。
- `--max-usd FLOAT` 如果预飞成本估计超过上限，则拒绝启动，除非 `--yes` 绕过（对于非交互式 cron / CI 是必需的）。
- 自动过滤 `kind: "by_type_summary"` 行（LongMemEval `--by-type` 摘要行是元数据，不是问题）。
- `--batch` 与 `--task` 互斥；如果两者都设置，则快速失败使用错误。
- 退出优先级（响亮失败）：ERROR > FAIL > INCONCLUSIVE > PASS。
- 每问题收据落在临时目录中，并在批处理结束时删除；摘要内联每问题判定，因此审计跟踪是自包含的。

### 每晚跨模态质量探测（选择加入，自动驾驶）

`src/core/cycle/nightly-quality-probe.ts` 发布一个阶段，每 24 小时运行一次 longmemeval + 跨模态管道。**默认禁用**以避免意外 API 支出。按主机启用：

```bash
gbrain config set autopilot.nightly_quality_probe.enabled true
gbrain config set autopilot.nightly_quality_probe.max_usd 5.00   # 可选覆盖
```

注意：`--phase nightly_quality_probe` 接入自动驾驶调度程序的接线被推迟到 v0.41+ 后续（请参阅 TODOS.md）。目前该阶段可以隔离调用；测试工具通过 DI 存根对其进行练习。

```bash
# 手动冒烟（通过 DI 存根练习路径，无真实 API 支出）。
bun test test/nightly-quality-probe.test.ts
```

可观察性：
- `~/.gbrain/audit/quality-probe-YYYY-Www.jsonl` — 每次运行一个事件，结果为 outcome（pass / fail / inconclusive / error / budget_exceeded / rate_limited / no_embedding_key）、pass/fail/inconclusive/error 计数、est_cost_usd、fixture_sha8。ISO 周轮换（镜像 slug-fallback 审计）。
- `gbrain doctor` 表面 `nightly_quality_probe_health`：
  - SKIPPED（禁用）— 带有可粘贴的启用命令。
  - OK（已启用，尚无事件）— 自动驾驶还没有触发其首次运行。
  - OK（最近 7 天全部 PASS）— 带有最新运行的时间戳。
  - WARN — 窗口中任何 FAIL / ERROR / BUDGET_EXCEEDED，带有结果计数和最新运行的原因。

真实预期成本：每晚运行约 $0.35（5 个问题 x 3 个槽 x 1 个周期 x 每次调用约 $0.02）≈ $10.50/月。默认预算上限下的最坏情况：$150/月。选择加入默认防止在您的信用卡对账单中发现此情况。
