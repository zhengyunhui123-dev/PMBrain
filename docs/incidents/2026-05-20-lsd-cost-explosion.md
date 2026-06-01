# 事件报告：LSD Brainstorm 53 倍成本超支

**日期：** 2026-05-20
**严重程度：** 高（财务 — 实际 $50.71 vs 预估 $0.96）
**组件：** `gbrain lsd` / `gbrain brainstorm`
**Brain 大小：** 13,690 个页面，16,314 个链接，约 2,000 个唯一目录前缀
**版本：** v0.37.1.0（brainstorm/lsd 的首个版本）

## 发生了什么

用户在 13,690 个页面的 brain 上运行了 `gbrain lsd "what story should Garry's List write next" --yes`。该命令：

1. **预估成本：$0.96**（2×12 = 24 次交叉 × 4 个想法 + 评判）
2. **实际成本：$50.71** — 超出预估 53 倍
3. **Token 使用：** 4,906,011 输入 + 2,399,239 输出 = 总计 7.3M tokens
4. **Far set 拉取了 1,985 个页面**而不是配置的 12 个
5. **生成了 15,868 个原始想法**跨越所有交叉（预期约 96 个）
6. **评判阶段失败：** 2,989,338 tokens 超出 Claude Sonnet 的 1M 上下文限制
7. **零想法展示给用户** — 完全失败

使用显式 `--limit 12` 重试：
- Far set 正确返回 12 个页面，成本为 $0.39
- 但评判仍然失败：`parseJudgeJSON: no strategy produced valid JSON`
- 再次，0 个想法存活到输出（生成了 96 个，0 个评分）

## 根本原因

### RC1：Far Set 爆炸（导致 $50 账单）

**文件：** `src/core/brainstorm/domain-bank.ts` → `fetchFar()` → `listPrefixSampledPages()`

领域库通过目录前缀采样页面以获得多样性。`listPrefixSampledPages` 对传入的每个前缀返回**一个页面**。在具有约 2,000 个唯一前缀的 13K 页面 brain 上（books/、civic/bundles/、civic/gl-article-*、people/、concepts/ 等），传递所有前缀会产生约 2,000 行 — 而不是配置的 `m=12`。

成本估算器使用 `m`（12）来预测交叉和成本。但实际交叉阶段接收 1,985 个 far-set 页面，产生 `2 × 1985 = 3,970` 次交叉，每次 4 个想法 = 15,868 个想法。

**估算公式对于预期行为是正确的；far set 选择才是偏离的地方。**

### RC2：没有成本断路器

没有机制来：
- 如果预估成本超过阈值则中止
- 如果实际支出偏离预估，在运行中中止
- 无论前缀数量如何都限制 far set 大小
- 在继续之前警告用户运行将很昂贵

`--yes` 标志跳过 10 秒的成本预览等待，甚至移除了手动检查的机会。

### RC3：评判上下文溢出

评判在单个提示中接收所有想法。有 15,868 个想法，每个约 350 tokens，那就是约 5.5M tokens — 远超任何模型的上下文窗口。

即使在只有 96 个想法的重试中，评判也因 JSON 解析错误而失败，表明评判提示/响应格式很脆弱。

### RC4：页面内容中的未配对 UTF-16 代理对

两次交叉失败并显示：`The request body is not valid JSON: no low surrogate in string`

某些页面（可能是 OCR 导入或网页抓取）包含未配对的 UTF-16 代理对。当这些被序列化到 LLM API 的 JSON 请求体中时，JSON 编码器会产生无效的 JSON。

### RC5：单个交叉没有超时

一次交叉超时，没有配置特定的超时。默认 HTTP 超时允许它在失败前挂起很长时间，在 API 端消耗 tokens。

## 观察到的 Token 流

```
配置：  2 close × 12 far = 24 次交叉 × 4 个想法 = 96 个想法 + 1 次评判调用
实际：  2 close × 1985 far = 3970 次交叉 × 4 个想法 = 15,868 个想法 + 1 次评判调用（失败）

每次交叉 tokens（预估）：约 1,200 输入 + 600 输出
实际总计：  4,906,011 输入 + 2,399,239 输出

仅评判调用就会是：
  15,868 个想法 × 约 350 tokens = 约 5.5M tokens（提示）
  模型限制：  1M tokens（Sonnet）
  溢出：  5.5× 上下文限制
```

## 提议的修复

### P1：Far Set 上限（关键 — 防止成本爆炸）

`fetchFar()` 必须在调用 `listPrefixSampledPages` 之前限制前缀数量。上限应为 `max(m * 4, 50)` 以允许一些多样性余量，同时防止失控增长。最终选择按距离分数修剪为 `m`。

**状态：** 在 `dc080ac2` 中实现。

### P2：成本护栏（关键 — 深度防御）

`brainstorm` 和 `lsd` 命令的新标志：
- `--max-cost <usd>`（默认 $5）：如果运行前预估超过则硬中止
- `--strict-budget`：如果运行成本超过预估 5 倍则在运行中中止
- `--max-far-set <n>`（默认 50）：显式 far set 大小上限

**状态：** 在 `dc080ac2` 中实现。

### P3：评判分块（关键 — 防止上下文溢出）

在调用评判 LLM 之前将想法分成约 100 个批次。每个批次是一个单独的 API 调用；结果连接起来。这将每次调用的 token 使用限制在约 35K，无论总想法数量如何。

**状态：** 在 `dc080ac2` 中实现。

### P4：Unicode 清理（中等 — 防止交叉失败）

在构建交叉提示之前，从页面内容中去除未配对的 UTF-16 代理对。这是任何将用户生成的页面内容序列化为 JSON 以进行 API 调用的 gbrain 函数的普遍问题。

**状态：** 在 `dc080ac2` 中实现。

### P5：所有分析函数的全局 Token 和时间预算（已提议）

**这是更大的架构需求。** 每个进行 LLM 调用的 gbrain 命令都应该遵守可配置的预算：

```yaml
# 提议添加到 ~/.gbrain/config.json 的配置
budgets:
  # 全局默认值
  default:
    max_input_tokens: 500_000    # 每个命令输入 token 上限
    max_output_tokens: 200_000   # 每个命令输出 token 上限
    max_cost_usd: 5.00           # 每个命令美元上限
    max_runtime_seconds: 300     # 5 分钟墙钟上限
    
  # 每命令覆盖
  brainstorm:
    max_cost_usd: 2.00
    max_runtime_seconds: 120
  lsd:
    max_cost_usd: 5.00
    max_runtime_seconds: 300
  dream:
    max_cost_usd: 10.00
    max_runtime_seconds: 600
  extract:
    max_input_tokens: 1_000_000
    max_runtime_seconds: 900
  enrich:
    max_cost_usd: 3.00
    max_runtime_seconds: 180
```

**受影响的命令：**
- `brainstorm` / `lsd` — 交叉关联 + 评判（本次事件）
- `dream` — 梦境循环阶段（丰富、情感权重等）
- `extract all` — 跨所有页面的链接 + 时间线提取
- `enrich` — 带网络研究的每页深度丰富
- `eval` — 评估运行（怀疑矛盾、检索漂移）
- `integrity auto` — 自动化内容修复
- `doctor --remediate` — 通过 Minions 自主自愈

**实现方法：**
1. 添加一个 `BudgetTracker` 类，用 token/成本/时间记账包装 LLM 调用
2. 每个分析函数接收一个预算上下文
3. 预算耗尽时：保存部分结果，发出结构化警告，干净退出
4. CLI 标志（`--max-cost`、`--max-tokens`、`--timeout`）覆盖配置默认值
5. `--no-budget` 逃生舱口供知道自己在做什么的高级用户使用

### P6：超大负载的日记化/摘要化（已提议）

当评判或分析阶段接收的内容超过上下文容量时：

1. **在调用 LLM 之前估算 tokens**
2. 如果超出预算，**日记化**：摘要/压缩内容以适应
3. 特别是评判：首先按廉价启发式排名想法（关键词重叠、新颖性分数），然后仅将前 N 个发送给 LLM 评判
4. 对于其他分析：渐进式摘要 — 分块 → 摘要 → 合并摘要 → 最终分析

这实际上是一个**token 预算分配器**，决定如何在可变长度的输入上花费固定的 token 预算。

```
示例：15,868 个想法需要评判，上下文限制 900K tokens
  步骤 1：廉价预过滤（关键词去重、明显重复）→ 8,000 个唯一想法
  步骤 2：分批为 80 个块，每个 100 个想法
  步骤 3：评判每个块 → 80 次调用 × 约 35K tokens = 总计 2.8M（分布在调用中）
  步骤 4：合并每个块中的顶级想法 → 最终排名
  总成本：约 $2-3 而不是 $50
```

### P7：结构化错误恢复（已提议）

当交叉或评判调用失败时：
- 立即保存部分结果（不要等待完整运行）
- 发出机器可读的错误事件（不仅仅是日志警告）
- 支持 `--retry-failed` 仅重新运行失败的交叉，而不重复成功的
- 将进度检查点到磁盘，以便中断的运行可以恢复

## 影响

- **财务：** 单次失败运行浪费 $50.71
- **用户信任：** 尽管处理了约 7M tokens，但交付了零想法
- **时间：** 约 15 分钟的计算时间，加上报告结果的 overnight 延迟

## 教训

1. **在任何新功能首次在大型 brain 上运行时应该是 dry-run 或有上限的。** 预估基于小型 brain 测试；13K 页面是一个不同的宇宙。
2. **成本估算器必须考虑实际数据基数，而不仅仅是配置的参数。** 预估使用 `m=12` 但实际的 far set 是 `|prefixes|`。
3. **每个调用 LLM 的函数都需要预算。** 这不仅仅是 brainstorm 的问题 — 这是任何基于数据大小进行可变数量 LLM 调用的系统中的架构缺口。
4. **用户内容的 JSON 序列化是一个地雷。** 任何页面都可能包含无效的 Unicode。在序列化边界清理，而不是每个功能。

## 在 v0.37.x 中发布（预算大教堂浪潮）

P1-P4 已经通过 PR #1234（第一波修复）发布。P5-P7 加上几个架构轮次在随后的预算大教堂浪潮中发布：

- **P1（far set 上限）：** `src/core/brainstorm/domain-bank.ts` 中的 `fetchFar()` 将前缀采样限制为 `max(m*4, 50)` 并按距离将最终页面修剪为 `m`。2K 前缀爆炸类已关闭。
- **P2（成本护栏）：** brainstorm + lsd 上的 `--max-cost`、`--max-far-set`、`--strict-budget`、`--judge-model`、`--max-ideas-per-judge-call` 标志。飞行前预估拒绝、运行中成本上限中止。
- **P3（评判分块）：** `src/core/brainstorm/judges.ts` 中的 `runJudge` 在 100 个想法/调用时自动分块。上下文窗口溢出在结构上被防止。
- **P4（unicode 清理）：** `src/core/brainstorm/orchestrator.ts` 中的 `sanitizeUnicode` 在序列化之前去除未配对的代理对。
- **P5（网关层的 BudgetTracker）：** 新的 `src/core/budget/budget-tracker.ts` 是规范原语。网关的 `withBudgetTracker(tracker, fn)` 通过 `AsyncLocalStorage<BudgetTracker>` 组合，因此范围内的每个网关路由 LLM 调用都会自动记录。`BudgetExhausted` 是一个类型化错误，原因为 `'cost' | 'runtime' | 'no_pricing'`。当累计支出超过上限时 `record()` 抛出（TX1）。当设置了上限 + 模型在定价映射中缺失时，`reserve()` 在 `no_pricing` 上硬失败（TX2）。
- **P6（payload-fitter）：** `src/core/diarize/payload-fitter.ts` 带有 `'batch'` 和 `'summarize'` 策略。摘要嵌入集群（k=ceil(items/4)），通过 `Promise.allSettled` 以并行度=4 并行 Haiku-摘要每个集群。当成功率 < 0.75 时显示 `degraded: true` 标志，以便调用者决定是否显示部分结果或中止。
- **P7（brainstorm 检查点 + --resume）：** `src/core/brainstorm/checkpoint.ts` 持久化完整的想法主体（不仅仅是计数 — TX3 承载）。一个 `--resume <run_id>` 标志覆盖失败和从未尝试的交叉（TX4）。`run_id` 公式不使用嵌入位，因此身份在嵌入模型交换中保持稳定（A5 修订）。基于 mtime 的 7 天 GC 连接到循环清除阶段。`--list-runs` 列出保存的检查点。`--force-resume` 绕过 7 天陈旧门。

同时随浪潮发布（内联折叠）：

- **doctor --remediate --resume：** A4 修订。运行中上限现在是真实上限；`--max-cost` 是 `--max-usd` 的别名。在 BudgetExhausted 上，编排器在 `~/.gbrain/remediation/<plan_hash>.json` 持久化检查点，并告诉用户确切的 `gbrain doctor --remediate --resume` 命令。恢复的运行跳过已完成的步骤。
- **审计周文件整合（Q1）：** 四个调用点（shell-jobs / phantoms / slug-fallback / dream-budget）现在共享一个 ISO 周文件名助手。年边界正确性由测试固定。
- **eval-contradictions tracker 遥测：** 现有 CostTracker 保留用于报告形状；运行器另外为网关层遥测路径安装 withBudgetTracker 范围。

本次浪潮中未包含的（归档在 TODOS 中以便后续）：

- PGLite 上 `page_links` 的 schema 修复。Brainstorm 领域库查询引用 `page_links` 但嵌入式 schema 仅定义 `links`；E2E 在测试设置中使用视图解决此问题，但真正的 PGLite 用户目前无法运行 `gbrain brainstorm`。需要 schema 修复。
- `extract`、`enrich`、`integrity auto` 上的 `--max-cost` 标志。当在入口点包装时，网关层强制执行覆盖它们，但 CLI 标志连接被推迟。
- 异步批处理审计写入。同步 `appendFileSync` 在典型卷下没问题；如果性能分析显示它占主导地位，请重新访问。
- 多天 brainstorm 恢复（>7 天）。`--force-resume` 标志现在是操作员逃生舱口。

---
*是 [GBrain 事件报告](../INCIDENTS.md) 的一部分。*
