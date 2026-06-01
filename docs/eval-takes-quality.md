# `gbrain eval takes-quality` — 可重现的跨模态质量评估

v0.32+ 发布了 takes 层的可 CI 质量门。三个前沿模型根据 5 维评分标准对 takes 样本进行评分，运行器聚合到 PASS / FAIL / INCONCLUSIVE，并且收据持久化到 `eval_takes_quality_runs`，因此后续的 `trend` 或 `regress` 可以与历史进行比较。

本文档是消费者契约。兄弟 [gbrain-evals](https://github.com/garrytan/gbrain-evals) 仓库和任何未来的 CI 门读取形状完全像下面 JSON 的收据。
字段在 `schema_version: 1` 处是附加稳定的。破坏性 shape 更改会提升版本。

## 子命令

| 命令 | 需要 Brain？ | 退出代码 |
|---|---|---|
| `gbrain eval takes-quality run [flags]` | 是（takes 样本） | 0 PASS, 1 FAIL, 2 INCONCLUSIVE |
| `gbrain eval takes-quality replay <receipt>` | **否**（仅磁盘） | 0 PASS, 1 FAIL, 2 INCONCLUSIVE |
| `gbrain eval takes-quality trend [flags]` | 是（读取运行表） | 0 |
| `gbrain eval takes-quality regress --against <receipt>` | 是 | 0 OK, 1 regression |

`replay` 是唯一在没有 `DATABASE_URL` 的情况下运行的模式 — 它从磁盘读取收据文件并重新渲染它。其他模式需要 brain。

## `run` 标志

| 标志 | 默认 | 说明 |
|---|---|---|
| `--limit N` | 100 | 来自 brain 的 N 个 takes 随机样本。 |
| `--cycles N` | 3 (TTY) / 1 (非 TTY) | 在放弃之前最多 N 个面板调用；早停于 PASS 或 INCONCLUSIVE。 |
| `--budget-usd N` | 未设置 | 在下一个调用的预计成本将超过上限之前中止。没有 `pricing.ts` 条目的模型大声失败（codex #4）。 |
| `--source db|fs` | `db` | `fs` 保留用于 v0.33+。 |
| `--slug-prefix P` | 未设置 | 将 takes 过滤到 slug 以 P 开头的页面。 |
| `--models a,b,c` | `openai:gpt-4o,anthropic:claude-opus-4-7,google:gemini-1.5-pro` | 逗号分隔的面板。 |
| `--json` | 关闭 | 将完整收据发出到 stdout。 |

## 收据 JSON shape (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "ts": "2026-05-09T22:00:00.000Z",
  "rubric_version": "v1.0",
  "rubric_sha8": "abcd1234",
  "corpus": {
    "source": "db",
    "n_takes": 100,
    "slug_prefix": null,
    "corpus_sha8": "abcd1234"
  },
  "prompt_sha8": "abcd1234",
  "models_sha8": "abcd1234",
  "models": ["openai:gpt-4o", "anthropic:claude-opus-4-7", "google:gemini-1.5-pro"],
  "cycles_run": 3,
  "successes_per_cycle": [3, 3, 2],
  "verdict": "pass",
  "scores": {
    "accuracy":            { "mean": 7.8, "min": 7, "max": 9, "scores": [9,7,7], "per_model": {...} },
    "attribution":         { "mean": 7.0, "min": 7, "max": 7, "scores": [7,7,7], "per_model": {...} },
    "weight_calibration":  { "mean": 7.5, "min": 7, "max": 8, "scores": [8,7,7], "per_model": {...} },
    "kind_classification": { "mean": 7.2, "min": 7, "max": 8, "scores": [7,8,7], "per_model": {...} },
    "signal_density":      { "mean": 7.0, "min": 6, "max": 8, "scores": [8,7,6], "per_model": {...} }
  },
  "overall_score": 7.3,
  "cost_usd": 1.85,
  "improvements": ["..."],
  "errors": [],
  "verdictMessage": "PASS: every dim mean >=7 and min >=5 ..."
}
```

### 字段参考

- `schema_version` — 锁定契约。添加可选字段是附加的并且兼容。重命名、删除或更改语义会提升版本。
- `rubric_version` + `rubric_sha8` — 按评分标准时期对趋势行进行隔离（codex review #3）。当评分标准定义更改时，两个字段都会更新，并且趋势模式相应地分组运行，因此更严格的评分标准不会静默地看起来像质量下降。
- `corpus.corpus_sha8` — 判断器看到的连接 takes-text 的指纹。确定两个运行是否在同一样本上。
- `models_sha8` — 排序模型 ID 列表上的指纹。在 `--models` 中重新排序模型不会改变 sha（排序是稳定的）。
- `successes_per_cycle` — 每个周期的贡献模型计数。当（a）其 JSON 已解析 AND（b）每个声明的评分标准维度都具有有限分数时，模型贡献（codex review #5 — 缺失维度丢弃贡献）。
- `verdict` — 如果每个维度均值 >= 7 AND 跨贡献模型的每个维度最小值 >= 5，则为 `pass`；否则为 `fail`；如果少于 2/3 模型贡献了完整分数，则为 `inconclusive`。
- `cost_usd` — 通过 `pricing.ts` 的每次调用成本之和。当设置 `--budget-usd` 时，未知模型在任何调用触发之前产生 `PricingNotFoundError`。

## 收据持久化

收据持久化到 **`eval_takes_quality_runs`**（根据 codex review #6 的 DB 权威）并且作为尽力而为的工件磁盘到 `~/.gbrain/eval-receipts/takes-quality-<corpus>-<prompt>-<models>-<rubric>.json`。
DB 行在 `receipt_json` JSONB 列中携带完整收据 JSON，因此当磁盘工件消失时，`replay` 仍然可以通过 `loadReceiptFromDb`（v0.33+ 标志接线）重建。

4-sha 主键是唯一的（`UNIQUE` 约束），因此重新运行相同的评估是 `INSERT ... ON CONFLICT DO NOTHING` — 幂等。

## 趋势输出

纯文本（默认）：

```
ts                   rubric  verdict       overall  cost     corpus
─────────────────────────────────────────────────────────────────────────────
2026-05-09T22:00:00  v1.0    pass             7.3   $1.85   abcd1234
2026-05-08T18:30:00  v1.0    fail             6.8   $1.92   ef567890
```

JSON shape (`--json`)：

```json
{
  "schema_version": 1,
  "rows": [
    { "id": 42, "ts": "...", "rubric_version": "v1.0", "verdict": "pass",
      "overall_score": 7.3, "cost_usd": 1.85, "corpus_sha8": "abcd1234" }
  ]
}
```

## Regress：基于质量的 CI 门控

```bash
# 捕获基线。
gbrain eval takes-quality run --limit 100 --json \
  > .ci/takes-quality-baseline.json

# 稍后，在更改提取提示后：
gbrain eval takes-quality regress --against .ci/takes-quality-baseline.json \
  --threshold 0.5
# exit 0 → 没有超过阈值的回归
# exit 1 → 某些维度下降 > 0.5；CI 失败
```

阈值是计为回归的每个维度均值下降。默认 0.5。
Regress 重用 **相同的** 模型面板 + slug 前缀 + 来源作为先前收据进行苹果对苹果的比较。`corpus_sha8` / `prompt_sha8` / `rubric_sha8` 中的差异作为信息性警告表面化（运行器不拒绝 — 这是调用者的调用）。

## 契约稳定性

上面的 shape 是下游消费者的读取契约。未列出的任何内容（例如内部聚合器状态、网关元数据）是：**不在**收据中，并且可能会在没有通知的情况下更改。

当你需要演进 schema 时：
1. 添加可选字段 → 无版本颠簸；旧消费者忽略新键，新消费者读取它。
2. 重命名或删除的字段，或更改的语义 → 将 `schema_version` 颠簸到 `2`；运行器为一个版本发出两种 shapes 作为弃用跑道。
