# Eval capture — NDJSON schema 参考

**状态：** 从 v0.21.0 开始稳定。通过每一行上的 `schema_version` 进行 Schema 版本控制；附加更改增加次要版本；删除是破坏性 schema-v2。

**受众：** 下游消费者（主要是兄弟 [gbrain-evals](https://github.com/garrytan/gbrain-evals) 仓库），它将捕获的真实世界查询作为 BrainBench-Real 夹具重放。

## 管道

```
MCP / CLI / subagent tool-bridge 调用者
     │
     ▼
src/core/operations.ts — 查询 + 搜索操作处理程序
     │
     │ (hybridSearch 或 searchKeyword)
     │
     ▼
{results, meta: HybridSearchMeta}                 ┌── captureEvalCandidate
     │                                             │    (即发即忘)
     ▼                                             │
return to caller                                   ▼
                                            scrubPii(query) ←── src/core/eval-capture-scrub.ts
                                                   │
                                                   ▼
                                           buildEvalCandidateInput
                                                   │
                                                   ▼
                                           engine.logEvalCandidate
                                                   │
                                    ┌──────────────┴──────────────┐
                                    │ success                     │ fail
                                    ▼                             ▼
                                INSERT into eval_candidates    engine.logEvalCaptureFailure
                                                                 (reason: db_down | rls_reject |
                                                                  check_violation |
                                                                  scrubber_exception | other)
```

## `gbrain eval export` — 消费者契约

```sh
gbrain eval export [--since DUR] [--limit N] [--tool query|search]
```

向 **stdout** 发出 NDJSON。每行 `\n` 终止的行一个 JSON 对象。stderr 接收进度心跳。每行以 `"schema_version": 1` 开头，因此前向兼容解析器可以在 schema v2 上大声失败，而不是静默错误解析。

gbrain-evals 的典型用法：

```sh
# 快照过去一周的真实流量以进行重放
gbrain eval export --since 7d > brainbench-real.ndjson
```

```sh
# 通过 jq 流式传输以进行临时分析
gbrain eval export --tool query | jq -c 'select(.latency_ms > 500)'
```

## 行 schema (v1)

每个导出的行都有这个 shape。JSON 输出中的字段顺序不保证；消费者必须按名称键入，而不是位置。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema_version` | number | 在 v1 行上始终为 `1`。前向兼容门。 |
| `id` | number | 自动递增主键。跨导出稳定。 |
| `tool_name` | `"query"` \| `"search"` | 哪个 MCP 操作捕获了此行。 |
| `query` | string | **已经过 PII 清理** by `scrubPii`，除非 `eval.scrub_pii: false`。电子邮件 / 电话 / SSN / Luhn 验证的信用卡 / JWT / bearer 令牌替换为 `[REDACTED]`。最大长度 50KB（CHECK 强制执行）。 |
| `retrieved_slugs` | string[] | 在 `SearchResult[]` 中返回的去重 slugs。 |
| `retrieved_chunk_ids` | number[] | 每个 chunk id 按结果顺序（保留重复 — 每次命中一个）。 |
| `source_ids` | string[] | 整个结果集中的不同 `sources.id` 值（v0.18 多来源）。对于缺少该列的前 v0.18 行，为空。 |
| `expand_enabled` | boolean \| null | 调用者是否**请求** Haiku 扩展。`null` 用于 `search`（无扩展概念）。 |
| `detail` | `"low"` \| `"medium"` \| `"high"` \| null | 调用者**请求**的详细级别。`null` 当省略时。 |
| `detail_resolved` | `"low"` \| `"medium"` \| `"high"` \| null | `hybridSearch` **实际使用的**在自动检测后。当调用者和启发式都没有分类时，`null`。 |
| `vector_enabled` | boolean | 当且仅当向量搜索实际运行时为 True。`false` 当 `OPENAI_API_KEY` 丢失或嵌入调用失败时。**重放必须尊重这一点** — 带有 `false` 的行仅使用了关键字路径。 |
| `expansion_applied` | boolean | 当且仅当 Haiku 扩展实际产生变体时为 True（不仅仅是"已请求"）。 |
| `latency_ms` | number | 操作处理程序的挂钟持续时间（包括捕获本身 — 因为即发即忘，所以可忽略）。 |
| `remote` | boolean | 用于 MCP 调用者（不受信任）为 `true`，用于本地 CLI 为 `false`。将"真实 agent 流量"与"操作员探测"分开。 |
| `job_id` | number \| null | 当调用者是 subagent tool-bridge 时的 `OperationContext.jobId`。用于 MCP + CLI 为 Null。 |
| `subagent_id` | number \| null | 用于 subagent 拥有的运行的 `OperationContext.subagentId`。 |
| `created_at` | string (ISO 8601) | 插入的 UTC 时间戳。 |

## 排序 + 确定性

`listEvalCandidates` 按 `created_at DESC, id DESC` 排序。同一毫秒插入在 `created_at` 上绑定；`id DESC` 是稳定的打破平局者。重放工具可以按顺序使用行，并假设：
- 在具有非重叠 `--since` 窗口的调用之间没有重复行
- 在链接 `--since` 窗口的调用之间没有错过的行（运行 1 的窗口结束时是严格的上限，而不是软游标）

## Schema 版本控制承诺

- **v1（已发布 v0.21.0）** — 本文档。上面列出的所有字段。
- **附加更改** 增加 gbrain 次要版本（v0.25.0、v0.23.0…）并附带新的可选字段。基于已知字段键入的消费者忽略未知键并继续工作。
- **破坏性更改**（重命名、类型更改、删除）将 `schema_version` 增加到 2。消费者必须根据 `schema_version` 分支以保持兼容。

## `eval_capture_failures` — 配套审计表

不由 `gbrain eval export` 导出。通过 `gbrain doctor` 表面化：

```sh
gbrain doctor   # 在过去 24 小时内失败时警告
```

原因枚举（稳定）：`db_down` | `rls_reject` | `check_violation` | `scrubber_exception` | `other`。跨进程可见性是整个重点 — `gbrain doctor` 在其自己的进程中运行并直接读取表，因此进程内计数器不起作用。

## 配置 + CONTRIBUTOR_MODE

从 v0.25.0 开始，捕获默认**关闭**（在早期草稿中对每个人都是打开的）。两种打开方法：

**路径 A — 环境变量（贡献者选择加入，常见情况）：**

```bash
export GBRAIN_CONTRIBUTOR_MODE=1     # 在 ~/.zshrc 或 ~/.bashrc 中
```

**路径 B — 显式配置（`~/.gbrain/config.json`，仅文件平面）：**

```json
{
  "engine": "postgres",
  "database_url": "...",
  "eval": {
    "capture": true,
    "scrub_pii": true
  }
}
```

解析顺序（最显式获胜）：

1. 配置中的 `eval.capture: true` → 打开
2. 配置中的 `eval.capture: false` → 关闭（覆盖 CONTRIBUTOR_MODE=1）
3. `GBRAIN_CONTRIBUTOR_MODE === '1'` → 打开
4. 否则 → 关闭

`scrub_pii` 默认独立于捕获为 `true`。设置 `eval.scrub_pii: false` 以保留原始查询文本（仅当你控制 brain 的分发时）。

`gbrain config set eval.capture false` 不起作用 — 该命令写入 DB 平面配置，而 MCP 服务器读取文件平面。直接编辑 JSON 或使用环境变量。
