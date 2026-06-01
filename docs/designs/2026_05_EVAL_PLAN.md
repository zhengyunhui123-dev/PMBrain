# 嵌入模型对决 — 2026年5月评估计划

**状态：** 已批准，准备执行
**负责人：** Garry
**计划来源：** `~/.claude/plans/system-instruction-you-are-working-linear-origami.md`（审查日志）
**目标耗时：** ~2周
**目标API开销：** ~$525（硬上限 $700）

## 本文内容

这是 v0.35.0.0 新多供应商网关路由下，三个嵌入提供商的正面 A/B/C 对比：

- **OpenAI** `text-embedding-3-large` @ 1536 维
- **Voyage** `voyage-4-large` @ 2048 维
- **ZeroEntropy** `zembed-1` @ 2560 维（另加 1280 维 Matryoshka 消融实验）

每个配置都测试是否使用 `zerank-2` 重排序器。使用两个语料库：公开 LongMemEval（500题）和内部 BrainBench（145条关系查询 + 50条新策划的 Cat 13 嵌入器敏感查询）。

目标：生成可发布的对比报告，回答"哪个嵌入器胜出，zerank-2 是否为 ZeroEntropy 带来了胜利"，并附带 bootstrap p 值，适合作为 v0.35.2.0 发行说明的标题。

## 设计原因

来自规划审查的锁定决策（见计划文件 + 链接计划底部的 `GSTACK REVIEW REPORT`）：

- **仅合成数据** — LongMemEval（公开）+ BrainBench（内部）。不使用 `~/.gbrain` 数据。
- **答案生成模式** — `gbrain eval longmemeval` 运行默认的答案生成路径（Anthropic Sonnet），然后将生成的假设 JSONL 传递给 LongMemEval 已发布的 `evaluate_qa.py`（OpenAI gpt-4o 评判）以获得真实正确性分数。
  `--retrieval-only` 不使用（会产生可被攻击的标题；评判期望答案文本，而非检索文本）。
- **`tokenmax` 搜索模式** 在所有单元格中固定（扩展 + 重排序器槽位激活）。
- **串行执行**，在一个工作区中。干净的速率限制配置文件；首次接触 ZE 时需要可调试的信号。
- **7单元格矩阵**（没有跨供应商的匹配维度行 — 三个供应商之间不存在共享维度；诚实的框架是"每个供应商在其营销的甜蜜点"）。

## 约束计划的结构性事实

- `content_chunks.embedding vector(N)` 维度在每个 brain 中固定。LongMemEval 中的按问题 PGLite 使这免费；BrainBench 需要每个单元格一个独立的 brain。
- pgvector HNSW 上限为 **2000 维**（`src/core/vector-index.ts:19` 中的 `PGVECTOR_HNSW_VECTOR_MAX_DIMS`）。Voyage 2048 和 ZE 2560 回退到精确向量扫描。有助于质量（无 HNSW 近似）但增加延迟。在撰写时作为脚注。
- 重排序器禁用键是 **`search.reranker.enabled false`**，而非 `reranker_model none`。
  `tokenmax` 模式默认 reranker=true。
- `gbrain/ai/gateway` 在 v0.35.0.0 中未导出。PR α 暴露它。

## 矩阵

| 单元格 | 嵌入器 | 维度 | HNSW | 重排序器 | 备注 |
|---|---|---|---|---|---|
| A0 | `openai:text-embedding-3-large` | 1536 | 是 | 无 | OpenAI 基线 |
| A1 | `openai:text-embedding-3-large` | 1536 | 是 | `zerank-2` | 混合供应商 |
| B0 | `voyage:voyage-4-large` | 2048 | 否（精确） | 无 | Voyage 单独 |
| B1 | `voyage:voyage-4-large` | 2048 | 否（精确） | `zerank-2` | 混合供应商 |
| C0 | `zeroentropyai:zembed-1` | 2560 | 否（精确） | 无 | ZE 嵌入器单独 |
| C1 | `zeroentropyai:zembed-1` | 2560 | 否（精确） | `zerank-2` | **ZE 全栈** |
| C2 | `zeroentropyai:zembed-1` | 1280 | 是 | `zerank-2` | ZE-Matryoshka 消融 |

## PR 结构 — 尽可能少

**PR α — gbrain 仓库：v0.35.1.0 基础设施。** 所有 gbrain 更改打包在一起。首先落地。
内部二分友好提交，最后整体发布。

**PR β — gbrain-evals 仓库：适配器 + 冒烟测试 + 策划 + 评估收据 + 撰写。** 较大的一个。
包括与生成它的代码一起提交的完整评估运行输出，以及对比撰写。在所有事情完成后落地。

**PR γ（可选）— gbrain 仓库：v0.35.2.0 发行**
交叉链接 gbrain-evals 基准测试的 CHANGELOG。小提交；无代码更改。

总计：2个实质性 PR + 1个可选发行提交。**没有中途发布。**

## 指挥者会话

下面的每个部分都是一个独立的简要说明。复制粘贴到新的指挥者会话中以移交。每个会话以一个干净的可交付成果结束。

---

## 会话 1 — PR α：gbrain 基础设施（v0.35.1.0）

**仓库：** `/Users/garrytan/conductor/workspaces/gbrain/<新建工作区>`（从 `master` 新建）
**分支：** `garrytan/v0.35.1.0-infra`
**时钟时间：** ~2h
**API 开销：** $0

### 本会话发布的内容

一个 PR 中的三项更改，打包在一起，以便 gbrain-evals（PR β）中的嵌入器对决有一个干净的前置基线：

1. 将 `voyage:voyage-4-large` ($0.18/M) 和 `zeroentropyai:zembed-1` ($0.05/M) 添加到嵌入定价表。修补 `gbrain models doctor` 成本估算器 + 测试。
2. 在 `package.json` 导出映射中暴露 `gbrain/ai/gateway`，以便 gbrain-evals 适配器可以外部调用 `configureGateway({embedding_model, embedding_dimensions, reranker_model})`。
3. 向 `gbrain eval longmemeval` 添加 `--resume-from <jsonl>`，以便中途运行中止（速率限制、成本上限、操作系统中断）不会丢失我们已经付费的单元格。

最后作为 v0.35.1.0 发布。

### 前置条件（开始前验证）

- 在 v0.35.0.0 基线上的 gbrain master。`cat VERSION` 显示 `0.35.0.0`。
- `bun test` 和 `bun run verify` 都在 master 上通过。

### 提交（二分友好，每个提交一个功能）

```
1. feat(pricing): 将 voyage-4-large + zembed-1 添加到 EMBEDDING_PRICING
   - src/core/embedding-pricing.ts: 添加两个条目
   - test/embedding-pricing.test.ts: 用 $0.18 和 $0.05 固定两者
   - 验证：bun test test/embedding-pricing.test.ts

2. feat(exports): 用金丝雀测试暴露 gbrain/ai/gateway
   - package.json: 向导出映射添加 "./ai/gateway"
   - test/public-exports.test.ts: 为 configureGateway + embed 添加金丝雀
   - scripts/check-exports-count.sh: 17 -> 18
   - 验证：bun run verify

3. feat(eval): 向 longmemeval 添加 --resume-from <jsonl>
   - src/commands/eval-longmemeval.ts: 解析标志，跳过输入 JSONL 中已存在的问题
   - test/eval-longmemeval.test.ts: 模拟中途运行中止 + 恢复回归
   - 验证：bun test test/eval-longmemeval.test.ts

4. chore: v0.35.1.0
   - VERSION: 0.35.1.0
   - package.json: 0.35.1.0
   - CHANGELOG.md: 新条目
   - bun install（刷新锁文件）
```

### 在 /ship 之前验证

```bash
bun run typecheck
bun run verify
bun test test/embedding-pricing.test.ts test/public-exports.test.ts test/eval-longmemeval.test.ts
```

### 发布

```bash
/ship
```

### 可交付成果

- gbrain 的 `master` 在 v0.35.1.0
- 外部消费者可以访问 `gbrain/ai/gateway`（通过金丝雀测试验证）
- `git tag eval-run-v0.35.1.0-baseline`（带注释，命名此确切提交）
- `gbrain --version` 打印 `0.35.1.0`

### 移交给会话 2

- gbrain-evals 现在可以 `bun update gbrain` 到 v0.35.1.0
- 标签保留了确切的提交，以备将来任何再现性需求

---

## 会话 2 — PR β 设置：gbrain-evals 适配器 + 冒烟测试 + 子集标志

**仓库：** `/Users/garrytan/git/gbrain-evals`（或从中克隆的新指挥者工作区）
**分支：** `garrytan/embedder-shootout`
**时钟时间：** ~3-4h
**API 开销：** ~$0.10（仅冒烟验证调用）

### 本会话发布到 PR β 的内容（尚不合并）

通过新暴露的 gbrain 网关连接 harness 以驱动 3 个嵌入提供商：

1. 新的类型化 `EvalAdapterConfig {embedder, dim, reranker?}` 传递到每个适配器。
2. 重写 `vector.ts` + `hybrid-rrf.ts` 以从 `gbrain/ai/gateway` 调用 `configureGateway()`，而不是硬编码的 `gbrain/embedding` 导入。
3. 关键：混合适配器还必须路由 `search.reranker.enabled`（true/false）和 `search.mode`（tokenmax）— codex 标记现有混合从不设置这些。
4. 新的 3 阶段冒烟 harness：布线（5个查询 × 嵌入往返 + 维度检查）+ long-haystack（1个查询 × 50K-token 合成 haystack）+ rerank-payload（1个查询 × `topNIn=30`）。退出代码是网关。
5. BrainBench 运行器上的新 `--include-subset <name>` 标志（Cat 13 布线；子集本身来自会话 3）。

### 前置条件

- 会话 1 完成。gbrain master 在 v0.35.1.0。
- API 密钥存在：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`VOYAGE_API_KEY`、
  `ZEROENTROPY_API_KEY`。缺少密钥时冒烟失败大声。

### 提交

```
1. chore(deps): 将 gbrain pin 提升到 v0.35.1.0
   - package.json + bun.lock
   - 验证：bun install && bun run typecheck

2. feat(adapter): 类型化 EvalAdapterConfig + 网关交换
   - 新建：eval/runner/eval-adapter-config.ts（类型）
   - eval/runner/adapters/vector.ts: 构造函数接受 EvalAdapterConfig，
     调用 configureGateway({embedding_model, embedding_dimensions})
   - 删除硬编码的 gbrain/embedding 导入
   - 验证：现有向量适配器单元测试仍然通过

3. feat(adapter): hybrid-rrf 布线 reranker_enabled + search.mode
   - eval/runner/adapters/hybrid-rrf.ts: 构造函数接受 EvalAdapterConfig，
     通过 search.reranker.enabled + search.mode = tokenmax 布线
   - 验证：bun test eval/

4. feat(smoke): 3阶段冒烟 harness
   - 新建：eval/runner/smoke.ts（CLI 入口：bun run eval:smoke -- --embedder X --dim Y [--reranker Z]）
   - 阶段1：5个查询 × 嵌入往返，断言向量维度与配置匹配
   - 阶段2：1个查询 × 合成 50K-token haystack，断言无 token 限制错误
   - 阶段3：1个查询 × topNIn=30 文档，断言没有 5MB payload 上限命中
   - 任何失败非零退出
   - 验证：bun run eval:smoke -- --embedder openai:text-embedding-3-large --dim 1536

5. feat(runner): BrainBench 的 --include-subset 标志
   - eval/runner/multi-adapter.ts: 解析标志，按子集标签过滤查询
   - 子集本身来自下一个提交（会话 3）
   - 验证：bun run eval:run -- --include-subset cat13-embedder（礼貌地错误，因为子集文件尚不存在）
```

### 冒烟验证（在打开 PR 之前手动运行）

```bash
bun run eval:smoke -- --embedder openai:text-embedding-3-large --dim 1536
bun run eval:smoke -- --embedder voyage:voyage-4-large --dim 2048
bun run eval:smoke -- --embedder zeroentropyai:zembed-1 --dim 2560
bun run eval:smoke -- --embedder zeroentropyai:zembed-1 --dim 2560 --reranker zeroentropyai:zerank-2
```

所有四个必须退出 0。报告应打印观察到的向量维度，与配置的维度匹配。

### 打开 PR β

```bash
gh pr create --base main --title "feat: embedder shootout (adapter + smoke + Cat 13 + eval receipts)" --body "$(cat <<'EOF'
## 摘要
v0.35.0.0 发布了 ZeroEntropy zembed-1 + zerank-2 重排序器支持。此 PR 在新网关路由下运行 OpenAI、Voyage 和 ZeroEntropy 的正面 A/B/C 对比。

这第一个提交批次落地 harness。Cat 13 策划、阶段1+2 评估和
撰写跟随此同一 PR 中的后续提交。

## 测试计划
- [x] 适配器单元测试通过
- [x] 冒烟 harness 对所有 3 个提供商退出 0
- [ ] Cat 13 子集已提交（会话 3）
- [ ] LongMemEval × 7 单元格运行（会话 4）
- [ ] BrainBench × 7 单元格运行（会话 5）
- [ ] 撰写已提交（会话 5）

🤖 使用 [Claude Code](https://claude.com/claude-code) 生成
EOF
)"
```

### 可交付成果

- PR β 针对 gbrain-evals `main` 打开，绿色 CI
- 针对所有 3 个提供商验证的冒烟测试（将冒烟输出粘贴到 PR 正文中）
- 准备好会话 3 的分支（Cat 13 策划）

### 移交给会话 3

- 分支 `garrytan/embedder-shootout` 存在于 origin
- `--include-subset cat13-embedder` 标志已布线，但子集文件尚不存在
   — 那是会话 3

---

## 会话 3 — PR β：Cat 13 概念回忆策划

**仓库：** `/Users/garrytan/git/gbrain-evals`，分支 `garrytan/embedder-shootout`（与会话 2 相同）
**时钟时间：** ~3-4h（重度用户交互；AI 提议，你逐个审查）
**API 开销：** $0

### 本会话发布到 PR β 的内容

从 BrainBench 的 Cat 13（概念回忆）语料库手工策划的 50 个对嵌入器敏感的查询。这些查询是图/关键词适配器可能会遗漏但语义适配器会找到的查询。

Codex 标记现有 145 题关系语料库以图/关键词为主，对嵌入器声明来说很弱。Cat 13 更接近嵌入器敏感的工作负载，但需要手工选择。

### 前置条件

- 会话 2 完成。PR β 打开了适配器 + 冒烟测试 + Cat 13 子集标志。

### 工作流

交互式：Claude 分批提议查询，每批 10 个，你接受/拒绝/编辑每个。

1. Claude 读取现有 Cat 13 原始查询池：
   ```bash
   ls eval/data/raw/ | grep -i cat13
   cat eval/data/raw/cat13-*.json | jq '.'
   ```
2. Claude 每批提议 10 个候选查询，每个都标记包含
   理由（"图适配器会错过这个吗？"）。
3. 用户接受/拒绝/内联编辑。目标：50个查询 × ~5批。
4. Claude 提交到 `eval/data/gold/brainbench-cat13-embedder-subset.json`：
   ```json
   {
     "schema_version": 1,
     "subset": "cat13-embedder",
     "queries": [
       {
         "id": "cat13-emb-001",
         "query": "...",
         "relevant_chunk_ids": ["..."],
         "inclusion_reason": "释义关系；图适配器不会捕获同义词"
       }
       // ... 另外49个
     ]
   }
   ```

### 提交

```
feat(eval): 策划 Cat 13 概念回忆子集（50个嵌入器敏感查询）
- 新建：eval/data/gold/brainbench-cat13-embedder-subset.json
- 每个查询都标记了 inclusion_reason 以备将来审计
```

### 提交前抽查

- 挑选 5 个随机查询，针对假设的图适配器运行它们（例如对
   相关术语进行 grep）并验证它们不会呈现正确的块。
- 针对现有混合适配器运行相同的 5 个，并验证它们会。

### 可交付成果

- `eval/data/gold/brainbench-cat13-embedder-subset.json` 提交到 PR β
- 恰好 50 个查询
- 提交消息中的抽查证据

### 移交给会话 4

- PR β 现在有：适配器 + 冒烟测试 + Cat 13 子集
- 准备好实际评估运行

---

## 会话 4 — PR β 阶段1：LongMemEval × 7 单元格（夜间）

**仓库：** 相同的 gbrain-evals 分支
**时钟时间：** ~10.5h（主要非接触式，启动然后离开）
**API 开销：** ~$476（LongMemEval 重的；7 × $68/单元格）

### 本会话发布到 PR β 的内容

7 个 LongMemEval 评分收据（每个矩阵单元格一个）。每个都是 500 个
假设的 JSONL + 来自 `evaluate_qa.py` 的正确性分数 JSON 文件。

### 前置条件

- 会话 1+2+3 完成。PR β 有适配器 + 冒烟测试 + Cat 13。
- LongMemEval 数据集已下载（受门控的 HuggingFace；一次性设置）。
- `evaluate_qa.py` 在某处检出（来自
  https://github.com/xiaowu0162/LongMemEval）并设置了它自己的 venv。
- API 密钥：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`VOYAGE_API_KEY`、
  `ZEROENTROPY_API_KEY`。

### 包装脚本

Claude 在 gbrain-evals 分支中编写 `scripts/run-shootout-phase1.sh`。单个
入口点，串行循环 7 个单元格，带有冒烟网关 + 成本上限中止。

```
新建：scripts/run-shootout-phase1.sh
- 每单元格：gbrain config set（嵌入器、维度、重排序器、search.reranker.enabled、search.mode=tokenmax）
- 每单元格：bun run eval:smoke（单元格非零时中止）
- 每单元格：gbrain eval longmemeval ... --output results/longmemeval-{cell}.jsonl
- 每单元格：成本上限检查（$90/单元格硬停止）
- 每单元格：如果存在则 --resume-from 现有 results/longmemeval-{cell}.jsonl
- 日志到 results/phase1-run-log.txt
```

### 运行

```bash
# 在后台启动；10-12小时后回来查看
bash scripts/run-shootout-phase1.sh 2>&1 | tee results/phase1-run-log.txt &
```

如果使用 Claude 运行，请使用 `run_in_background: true`。定期回来查看。

### 评分（所有 7 个单元格完成后）

```bash
for cell in A0 A1 B0 B1 C0 C1 C2; do
  python evaluate_qa.py \
    --input results/longmemeval-${cell}.jsonl \
    --output results/longmemeval-${cell}-scored.json
done
```

每个评分文件都有正确性 %。

### 提交

```
1. feat(scripts): 带冒烟网关 + 成本上限的阶段1 LongMemEval 包装器
   - 新建：scripts/run-shootout-phase1.sh

2. data(phase1): 7个 LongMemEval 单元格（原始假设 JSONL）
   - results/longmemeval-{A0,A1,B0,B1,C0,C1,C2}.jsonl
   - results/phase1-run-log.txt（运行计时 + 成本分类账）

3. data(phase1): evaluate_qa.py 评分结果
   - results/longmemeval-{cell}-scored.json × 7
```

### 验证

- 每个 `longmemeval-{cell}.jsonl` 恰好有 500 行
- 每个 `hypothesis` 字段非空且是实际答案文本（不是检索文本）
- 每个 `scored.json` 都有一个 `correctness_score` 字段

### 可交付成果

- 7 个评分的 LongMemEval 收据提交到 PR β
- 真实成本分类账与估计一起提交（与估计对比）

### 移交给会话 5

- 阶段1完成。阶段2（BrainBench，~3.5h）和撰写剩余。

---

## 会话 5 — PR β 阶段2 + 撰写 + 发布

**仓库：** 相同的 gbrain-evals 分支
**时钟时间：** ~7h（3.5h BrainBench + 3h 撰写 + /ship）
**API 开销：** ~$56（BrainBench 便宜）

### 本会话发布到 PR β 的内容

- 7 个 BrainBench 单元格（关系语料库 + Cat 13 子集）
- 最终对比撰写
- PR β 合并

### 前置条件

- 会话 4 完成。PR β 有阶段1收据。

### 阶段2包装脚本

```
新建：scripts/run-shootout-phase2.sh
- 每单元格：配置提供商（与阶段1相同）
- 每单元格：bun run eval:run -- --N 10 --include-subset cat13-embedder
  --output docs/benchmarks/2026-05-22-{cell}.md
- 成本上限检查
```

### 运行

```bash
bash scripts/run-shootout-phase2.sh 2>&1 | tee results/phase2-run-log.txt
```

### 撰写

`docs/benchmarks/2026-05-22-embedder-shootout.md`。结构：

1. **标题表格** — 7个单元格 × {LongMemEval 正确性 %, BrainBench 关系 MRR + P@5, Cat 13 正确性 %, 总成本}
2. **回答两个问题：**
   - 哪个嵌入器单独胜出？（A0 vs B0 vs C0）
   - zerank-2 是否为 ZE 带来了胜利？（C0 vs C1 vs A1 vs B1）
   - 奖励：维度对 ZE 重要吗？（C1 vs C2）
3. **成对 bootstrap p 值** 每对标题（方法在
   `gbrain/docs/eval/SEARCH_MODE_METHODOLOGY.md` 中）
4. **HNSW 脚注** — Voyage 2048 和 ZE 2560 使用精确向量扫描；OpenAI 1536
   和 ZE 1280 使用 HNSW。质量是主要的，延迟是次要的
5. **这不能证明什么** — 仅合成数据，仅 tokenmax，无真实 brain 重放
6. **建议：** 明确不建议更改 `gbrain init` 默认值；
   推迟到 v0.36.x 证据通行证，使用真实 brain 重放数据

### 提交

```
1. feat(scripts): 阶段2 BrainBench 包装器
   - 新建：scripts/run-shootout-phase2.sh

2. data(phase2): 7个 BrainBench 单元格
   - docs/benchmarks/2026-05-22-{cell}.md × 7

3. docs(benchmark): 嵌入器对决对比撰写
   - 新建：docs/benchmarks/2026-05-22-embedder-shootout.md
   - Bootstrap p 值，HNSW 脚注，NOT-in-scope 部分
```

### 发布

```bash
# 合并 PR β 到 gbrain-evals main
gh pr merge --squash --auto
# 或者如果再审查一次：
gh pr merge --squash
```

### 可交付成果

- PR β 合并到 gbrain-evals `main`
- 对比报告公开在
  `gbrain-evals/docs/benchmarks/2026-05-22-embedder-shootout.md`

### 移交给会话 6（可选）

- gbrain-evals master 有完整数据 + 撰写
- 准备好交叉链接它的 v0.35.2.0 gbrain 发行

---

## 会话 6（可选）— PR γ：gbrain v0.35.2.0 发行

**仓库：** `/Users/garrytan/conductor/workspaces/gbrain/<新建工作区>`（从 master 新建）
**分支：** `garrytan/v0.35.2.0-benchmark-release`
**时钟时间：** ~30min
**API 开销：** $0

### 本会话发布的内容

一个仅发行说明的 PR，将 gbrain 提升到 v0.35.2.0，并带有交叉链接嵌入器对决基准测试的 CHANGELOG 条目。可选 — 如果不急，可以折叠到下一个常规发行中。

### 前置条件

- 会话 5 完成。gbrain-evals 与对比撰写合并。

### 提交

```
1. docs(benchmark): 镜像嵌入器对决摘要
   - 新建：docs/benchmarks/2026-05-22-embedder-shootout.md（精简镜像）
   - 交叉链接到 gbrain-evals 规范版本

2. chore: v0.35.2.0
   - VERSION: 0.35.2.0
   - package.json: 0.35.2.0
   - CHANGELOG.md: 带有 GStack 声音发行摘要的新条目
     + 来自基准测试的"重要的数字"表格
```

### 发布

```bash
/ship
```

### 可交付成果

- master 上的 gbrain v0.35.2.0
- 驱动发行说明标题的 CHANGELOG 条目

---

## 成本分类账（修订后，审查后）

| 组件 | 每单元格 | × 7 单元格 |
|---|---|---|
| LongMemEval 嵌入 | <$0.05 | <$0.35 |
| LongMemEval Sonnet 答案生成（500q × 2K tokens × $3/M） | $18 | $126 |
| LongMemEval gpt-4o 评判（500q × $0.10/q） | $50 | $350 |
| BrainBench 关系嵌入 | $0.05-0.18 | <$1 |
| BrainBench Cat 13 答案生成 + 评判（50q × $0.14） | $7 | $49 |
| 冒烟 harness（30 次调用/单元格） | <$0.10 | <$1 |
| **总计** | **~$75/单元格** | **~$525** |

**硬上限：$700。** 每单元格硬上限：$90（如果超过，包装器中止单元格；部分
JSONL 保留用于恢复）。

## 失败模式和恢复

| 失败 | 恢复 |
|---|---|
| Voyage/ZE 429 速率限制中途单元格 | `gateway._shrinkState` 减半 safety_factor 并重试。单元格继续。 |
| ZE 5MB 重排序 payload 上限命中 | `applyReranker` 失败打开，返回未重排序的结果。Stderr 警告。 |
| 中途操作系统中断 / 成本上限中止 | 使用 `gbrain eval longmemeval --resume-from results/longmemeval-{cell}.jsonl` 重新运行。从它离开的地方拿起。 |
| `evaluate_qa.py` 认证失败 | 包装器中的 OPENAI_API_KEY 检查在任何开销之前中止。 |
| 适配器拼写错误（错误维度） | `EvalAdapterConfig` 构造函数中的运行时断言抛出 AIConfigError。单元格在任何 API 调用之前中止。 |

## 范围外（故意）

- **真实 `~/.gbrain` 重放** — 增加 6-12h 时钟时间 + $40-80 嵌入。归档为 v0.36.x。
- **所有 3 种搜索模式** — 固定到 tokenmax。`conservative` + `balanced` 是 v0.35.3.0
  如果审阅者回推，则跟进。
- **匹配维度跨供应商行** — 所有 3 个供应商之间不存在共享维度。
  永久退出。
- **`gbrain eval whoknows` / `cross-modal` / `takes-quality`** — 嵌入不变；
  跨嵌入器重新运行会产生噪音。
- **`gbrain eval code-retrieval`** — 代码语料库，单独关注。
- **`gbrain eval suspected-contradictions`** — 需要真实的 brain。
- **`gbrain init --recommended` 默认更改** — codex 正确标记证据
  库不足。推迟到 v0.36.x 使用真实 brain 重放数据。

## 已存在的内容（重用，不重建）

- `gbrain eval longmemeval` CLI（树内，答案生成模式默认）
- gbrain-evals BrainBench 运行器（`eval:run`）— 需要适配器参数化但是
  每单元格测试管道是重用的
- Voyage + ZE 的网关路由（发布了 v0.35.0.0）
- 重排序器管道（`src/core/search/rerank.ts`，失败打开）
- 定价表（扩展，不重建）
- 成对 bootstrap 方法（`docs/eval/SEARCH_MODE_METHODOLOGY.md`）
- LongMemEval 已发布的 `evaluate_qa.py`（外部调用，不打包）
