# 校准质量门 — 可证伪性过滤器 + 类别分类

> **历史背景。** 这是从 PR #1191 吸收而来的源规范，分为
> 两个实施波次：
>
> - **v0.37.2.0 热修复**（本次发布）：拓宽 `takes_resolution_consistency`
>   检查约束以接受 `quality='unresolvable'` 作为第 4 个有效状态。
>   解除生产分级脚本的阻塞。将 `unresolvable_count` +
>   `unresolvable_rate` 添加到 `TakesScorecard` 作为兄弟字段（保留
>   v0.36.1.0 历史比较语义）。迁移在连续多次主干合并期间将版本号从 v74 改为 v79→v80 —
>   v0.37.0.0 的自主修复波次
>   占据了 v68-v78，然后 v0.37.1.0（brainstorm/lsd）占据了 v79。
> - **后续次要版本**（即将到来）：`propose_takes` 中的可证伪性 + 类别提取，
>   SQL 端分级门，每类别校准记分卡，
>   pg_trgm 基础的提案去重。波次阻塞在针对
>   v0.36.1.0 夹具的 cat15 F1 重新验证上。
>
> 根据热修复计划的 PR #1191 关闭协议在此处保留，以便
> 生产上下文（96K 页面大脑，6.8% 可证伪率，类别
> 细分）不会在 CHANGELOG → 发行说明压缩过程中丢失。

## 问题

v0.36.1.0 发布 `propose_takes`、`grade_takes` 和 `calibration_profile` 作为一个
连接的管道：提取主张 → 对照结果对其进行分级 → 构建
显示系统性偏差的校准配置文件。

在具有 36K 主张、分布在 6,239 个持有者中的 96K 页面大脑上
进行生产时，`grade_takes` 阶段会产生噪声结果：

- **6.8% 可证伪率**：在 500 个候选主张（权重 ≥0.7）中，只有 34 个
  通过了 LLM 可证伪性过滤器。其他 93% 是哲学信念、
  现状观察、建议、物流或模糊的氛围。
- **50% 无法解决**：即使在过滤后，34 个预测中的 17 个也无法
  进行分级，因为证据不足或主张过于模糊。
- **重复项**：来自同一页面的同一主张被多次提取，
  措辞略有不同。

根本原因：`propose_takes` 会提取所有看起来像是信念或
断言的内容。这对于 *takes* 表（认识论层）是正确的，但是
`grade_takes` 需要一个更窄的子集：**关于
未来结果的可证伪预测**，我们可以对照实际发生的情况
进行检查。

### 生产测试中的示例分类

**真正的预测（值得分级）：**

- "X 将很快达到 $1M ARR" → company_outcome
- "X 将要离开 Y" → people_move
- "AI 将使真正的作者身份变得更加重要" → technology
- "X 确信 Y 将赢得 Z 市场" → market_call

**不是预测（应该跳过分级）：**

- "欲望是模仿性的" → 哲学信念
- "X 应该收费提高 10 倍" → 建议
- "周一从多伦多返回" → 物流
- "那里将会发生一些事情" → 模糊/不可证伪
- "X 正在非常快速地增长" → 现状观察

## 解决方案

### 1. 提取时的可证伪性评分

向 `takes` 表添加一个 `falsifiability` 列（实数，0.0–1.0，可为空，
默认为空）。`propose_takes` 在提取期间使用相同的 LLM
调用（已经产生主张）设置此项 — JSON 模式中只有一个附加字段。

```sql
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability real;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability_category text;
```

LLM 提示词补充（附加到现有的 propose_takes 提取提示词）：

```
对于每个主张，同时评估：
- falsifiability (0.0-1.0)：能否根据未来的现实情况检查此主张？
  1.0 = 关于结果的特定、可衡量、有时间限制的预测
  0.5 = 部分可检查的定向主张
  0.0 = 哲学信念、建议、观察或不可证伪的主张
- falsifiability_category：其中之一
  company_outcome | fundraising | technology | people_move | market_call | other_prediction | not_prediction
```

成本：~0 增量 token（主张已经被提取；这会在 JSON 输出模式中
添加两个字段）。

### 2. `grade_takes` 中的分级门

在尝试分级之前，进行过滤：

```typescript
const gradeable = candidates.filter(t =>
  t.falsifiability !== null && t.falsifiability >= 0.7
  && t.falsifiability_category !== 'not_prediction'
);
```

这在生产中将分级量减少了约 93%，这意味着：

- 用于分级的 LLM 成本成比例下降
- 证据检索负载下降（每次分级尝试都会触发混合搜索）
- 校准配置文件建立在真正的预测之上，而不是噪声

### 3. 提取时的去重

`propose_takes` 应该在插入之前检查近似重复的的主张：

```typescript
// 在插入新主张之前，检查是否存在类似的主张
// 对于来自同一页面的同一持有者
const existing = await engine.sql`
  SELECT id, claim FROM takes
  WHERE holder = ${holder}
  AND page_id = ${pageId}
  AND similarity(claim, ${newClaim}) > 0.8
  LIMIT 1
`;
if (existing.length > 0) {
  // 跳过 — 近似重复项
  continue;
}
```

需要 `pg_trgm` 扩展（在大多数 Postgres 安装中已可用）。
优雅地回退：如果 `similarity()` 不可用，则跳过去重检查。

### 4. 感知类别的校准配置文件

`calibration_profile` 阶段现在可以按
`falsifiability_category` 对已解决的主张进行分组，以生成每域记分卡：

```
"你的 company_outcome 调用有 73% 的准确率。
 你的 people_move 调用有 90% 的准确率。
 你的 technology 调用有 60% 的准确率 — 你往往大约提前 18 个月。"
```

这是可发布到推文的输出：一个校准配置文件，上面写着"按类别划分，
你系统性地正确和错误的方式"。

## Schema 更改

```sql
-- 迁移：向 takes 添加 falsifiability 列
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability real;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS falsifiability_category text;

-- 用于 grade_takes 过滤的索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_takes_falsifiability
  ON takes (falsifiability)
  WHERE falsifiability IS NOT NULL AND falsifiability >= 0.7;

-- 可选：用于去重的 pg_trgm（CREATE EXTENSION IF NOT EXISTS pg_trgm;）
```

## 证据检索（v0.36.1.0 → v0.37 增强）

当前的 `grade_takes` 证据检索器返回一个存根占位符。在
生产测试中，我们通过 `gbrain query`（混合
搜索）连接了真实的证据检索。有效的模式：

1. 从主张中提取核心主张（前 150 个字符）
2. 运行 `engine.query(claim)` 以获取相关页面
3. 过滤到在主张的 `since_date` 之后更新的页面（证据必须是更新的）
4. 将前 5 个块作为证据块传递给判断器

这应该替换 `evidenceRetriever` 注入点中的存根。

## 生产结果

在实施可证伪性过滤器后（作为循环外的预处理步骤）：

| 指标 | 之前（v2，无过滤器） | 之后（v3，带过滤器） |
|--------|----------------------|----------------------|
| 评估的候选者 | 50 | 34（来自 500 个筛选的） |
| 可证伪的预测 | ~19 (38%) | 34 (100%) |
| 正确 | 10（可解决部分的 52.6%） | 10（可解决部分的 58.8%） |
| 不正确 | 5 (26.3%) | 2 (11.8%) |
| 部分 | 4 (21.1%) | 5 (29.4%) |
| 无法解决 | 31 (62%) | 17 (50%) |
| 类别细分 | N/A | people_move:13, company_outcome:11, technology:4, market_call:2 |

关键改进：**可分级集中的假阳性率从 62% 噪声下降到 0% 噪声**。
剩余的 50% 无法解决率是真实的 — 那些
预测是关于尚未发生的结果，或者大脑
缺乏证据。这是正确的行为，而不是噪声。

## 要更改的文件

1. **`src/core/cycle/propose-takes.ts`** — 将可证伪性 + 类别添加到
   提取提示词和输出模式
2. **`src/core/cycle/grade-takes.ts`** — 在分级之前添加可证伪性门；
   连接真实的证据检索
3. **`src/core/cycle/calibration-profile.ts`** — 按类别对记分卡进行分组
4. **`src/core/engine.ts`** — 为去重添加 `similarity()` 辅助函数（优雅地
   回退）
5. **新迁移** — 添加列 + 索引

## 测试

- 单元测试：对 20 个已知良好和 20 个已知噪声主张进行可证伪性分类器测试
- 单元测试：去重正确地合并近似相同的主张
- 单元测试：分级门过滤低于阈值的主张
- 集成测试：可证伪性 → 分级 → 配置文件管道的完整循环
- 回归测试：没有可证伪性评分的现有主张不会被破坏
  （空可证伪性 = 无门控，向后兼容）

## 向后兼容性

- `falsifiability` 默认为空。现有主张不受影响。
- 带有空可证伪性的 `grade_takes`：可配置行为。默认：
  对所有进行分级（向后兼容）。操作员可以设置
  `cycle.grade_takes.require_falsifiability: true` 来设置门控。
- 类别列完全是附加的。
- 去重是选择加入的：`cycle.propose_takes.dedup.enabled: true`。
