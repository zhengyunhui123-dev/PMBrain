# Doctor 自动修复和评分改进

## 摘要

`gbrain doctor` 健康评分系统有几个误报模式和缺失的自动修复能力。在崩溃分类修复（在此 PR 中发布）之后，这些是按影响排名的剩余改进。

---

## 1. Frontmatter 严重级别

### 问题

`NESTED_QUOTES` 警告在 frontmatter 检查中占主导地位（约 7,100 个总问题中的 6,900+）。这些是表面化的 YAML 样式问题 — 像 `title: "foo"` 这样的值在技术上是不必要的。它们不影响同步、搜索、嵌入或任何功能。

通过将其与 `YAML_PARSE`（实际解析失败）或 `MISSING_OPEN`（缺少 frontmatter 分隔符）相同计数，frontmatter 检查永久是 WARN，真正的问题丢失了。

### 证据

```
frontmatter_integrity: 7131 issues across 3 sources
  default: 7012 (NESTED_QUOTES=6922, YAML_PARSE=90)
  media-corpus: 16 (MISSING_OPEN=15, YAML_PARSE=1)
  zion-brain: 103 (MISSING_OPEN=14, NESTED_QUOTES=89)
```

7,131 个问题中只有 280 个是真正的问题。96% 是表面噪声。

### 提议的修复

- 引入严重级别：`error`（`YAML_PARSE`、`MISSING_OPEN`）与 `info`（`NESTED_QUOTES`）
- Doctor WARN/FAIL 仅针对错误级别的问题
- 在消息文本中报告信息级别但不影响检查状态
- 可选的 `--pedantic` 标志在状态中包括信息级别

### 测试用例

| Frontmatter 问题 | 严重级别分解 | 预期状态 |
|---|---|---|
| 0 个问题 | 不适用 | OK |
| 仅 50 个 NESTED_QUOTES | 0 错误，50 信息 | OK（带注释） |
| 3 个 YAML_PARSE | 3 错误 | WARN |
| 6900 个 NESTED_QUOTES + 3 个 YAML_PARSE | 3 错误，6900 信息 | WARN（提及 3 个错误） |

---

## 2. 时间矛盾感知

### 问题

矛盾探测将时间演变标记为矛盾。示例：

- 页面 A（4 月）："正在考虑选项 X"
- 页面 B（5 月）："决定选项 Y"

这些不是矛盾 — 它们是同一主题随时间演变。探测没有时间感知。

### 证据

从在 50 个查询上的探测运行，top-k=15：
- 检测到 120 个矛盾（112 个高，8 个中等）
- 人工审查后：约 60% 是时间演变，不是真正的冲突
- 页面具有可用于消除歧义的 `effective_date` 或 `created` 时间戳

### 提议的修复

- 将 `effective_date` / `created` 传递给评判提示
- 添加裁决：`temporal_suppression`（后来的声明取代较早的）
- 当两个页面都有日期并且声明重叠时，偏向时间解释
- 已在 PR #993 中设计

### 测试用例

| 页面 A 日期 | 页面 A 声明 | 页面 B 日期 | 页面 B 声明 | 预期裁决 |
|---|---|---|---|---|
| 2026-04 | "正在考虑 X" | 2026-05 | "选择了 Y" | temporal_suppression |
| 2026-04 | "收入是 $1M" | 2026-04 | "收入是 $500K" | contradiction |
| null | "X 是真的" | null | "X 是假的" | contradiction |
| 2025-01 | "CEO of Company" | 2026-01 | "前 CEO" | temporal_suppression |

---

## 3. 多源漂移基线

### 问题

由于 pre-v0.30.3 `putPage` 路由 bug，4,791 个页面显示"多源漂移"。这些页面存在于 `default` 源中，但应该在命名的源中。修复此问题的 `sources rehome` 命令尚未发布。

每次 doctor 运行都显示约 4,800 个页面的 WARN，没人能修复。

### 提议的修复

允许 `doctor.baselines` 配置确认已知无法修复的计数：

```yaml
doctor:
  baselines:
    multi_source_drift: 4800
```

当实际漂移 ≤ 基线时：OK。当漂移超过基线时：WARN（新的漂移）。

存储在 `.gbrain/doctor-baselines.json` 中，因此它在没有配置的情况下也能工作：

```json
{
  "multi_source_drift": { "count": 4800, "acknowledged_at": "2026-05-15", "reason": "pre-v0.30.3 putPage misroutes" }
}
```

### 测试用例

| 实际漂移 | 基线 | 预期 |
|---|---|---|
| 4791 | 4800 | OK |
| 4900 | 4800 | WARN（"基线之外 100 个新漂移"） |
| 4791 | 0（无基线） | WARN（当前行为） |

---

## 4. 图像资产确认

### 问题

当图像文件从磁盘丢失（存储在外部，从 git 清除）时，检查永久警告。无法说"这些是有意外部的。"

### 提议的修复

- `doctor --acknowledge image_assets` 将当前缺失计数标记为已接受
- 存储在 `.gbrain/doctor-baselines.json` 中
- 仅针对超出确认计数的新缺失图像发出 WARN
- 可选的 `image_assets.external_storage: true` 配置以完全跳过磁盘检查

---

## 5. 自动修复模式

### 问题

许多 doctor 警告都有已知的安全自动应用的修复：

| 警告 | 自动修复 |
|---|---|
| Supervisor not running | 启动 supervisor |
| Stale embeddings | 提交 `embed --stale` 作业 |
| Extract coverage < 70% | 提交 `extract all --skip-existing` 作业 |
| Stale sync | 提交 sync 作业 |
| Effective date drift | 运行 `reindex-frontmatter` |

### 提议的修复

`doctor --auto-heal` 模式：

1. 运行所有检查
2. 对于可修复的 WARN：提交修复作为作业（不是内联的 — 通过作业队列）
3. 报告已修复的内容 vs 需要手动关注的内容
4. 幂等：首先检查队列，不要提交重复项
5. 安全网关：绝不自动修复 FAIL，仅 WARN

配置：

```yaml
doctor:
  autoHeal:
    enabled: true
    minInterval: "6h"
    skip:
      - image_assets
      - multi_source_drift
```

### 测试用例

| 检查状态 | 自动修复启用 | 作业已排队 | 预期 |
|---|---|---|---|
| WARN：stale embeds | 是 | 否 | 提交 embed 作业 |
| WARN：stale embeds | 是 | 是 | 跳过（幂等） |
| FAIL：max_crashes | 是 | 不适用 | 不要自动修复 FAIL |
| WARN：stale embeds | 否 | 不适用 | 仅报告 |
| WARN：image_assets | 是（但已跳过） | 不适用 | 仅报告 |

---

## 6. 分数增量跟踪

### 问题

没有历史 — 每次 `doctor` 运行都是一个快照。无法判断分数是在改善还是在退化。

### 提议的修复

- 将每次运行写入 `.gbrain/doctor-history.jsonl`：
  ```json
  {"ts":"2026-05-15T12:00:00Z","score":60,"brain_score":79,"checks":{"supervisor":"ok","embeddings":"ok",...}}
  ```
- `doctor --trend` 显示最后 N 个分数及增量
- `doctor --json` 包括 `previous_score` 和 `delta` 字段

---

## 7. 加权评分

### 问题

从 99% → 100% 嵌入覆盖率与 50% → 51% 的权重相同。但最后一个百分比是最难的（超大页面、速率限制）。

### 提议的修复

基于阈值的评分：
- 100% = 满分
- ≥95% = 90% 的分数
- ≥80% = 70% 的分数
- <80% = 按比例

---

## 优先级顺序

1. Frontmatter 严重级别（最高噪声减少）
2. 时间矛盾感知（最高误报减少，已设计）
3. 自动修复模式（最大的长期价值）
4. 分数增量跟踪（启用监控）
5. 多源漂移基线（生活质量）
6. 图像资产确认（生活质量）
7. 加权评分（ nice to have）
