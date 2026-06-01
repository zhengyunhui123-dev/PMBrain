# 提案：矛盾探测的时间轴

**状态：** 报告 / RFC
**日期：** 2026-05-14
**背景：** 大规模运行 `gbrain eval suspected-contradictions` 发现了约115个HIGH级别发现。手动检查这些发现后，暴露了探测器的结构性限制。

## 问题

矛盾探测器（`gbrain eval suspected-contradictions`）将所有声明视为永恒的。当两个文本块包含冲突的语句时，判断器会标记为一个矛盾，而不管这两个语句在各自的时间点上是否都为真。

当brain主要由静态wiki页面组成时，这种方法运行良好。但现在brain包含以下内容时，它就失效了：
- 对话记录，其中的声明在说出时是正确的
- 捕获特定日期人们所说内容的会议页面
- 演变的takes（创始人1月的ARR声明 vs 7月的）
- 相互取代的状态记录（状态从"trial"变为"confirmed"）

探测器无法区分"这个改变了"和"这个是错的"。

## Bug类别示例（合成占位符）

### 1. 时间演变（误报）

```
发现: HIGH
  A: [daily/transcripts/2026/2026-04-28] "status: trial"
  B: [meetings/2026-05-07-session] "status: confirmed"
  Axis: 状态是trial还是confirmed
```

截至各自日期，两者都是正确的。4月28日：trial。5月7日：confirmed。探测器标记此问题是因为它没有"此声明在X时间有效，直到Y"的概念。5月7日的记录并没有使4月28日的记录错误；它记录了一个变化。

### 2. 否定解析（误报）

```
发现: HIGH
  A: [people/alice-example] "person traveled to city-a for alice-example's event — NOT bob-example's event"
  B: [meetings/2026-05-11-context] mentions of bob-example's event in city-b
  Axis: city-a之旅是为谁的活动
```

消歧事实包含"NOT bob-example's event"作为显式否定。判断器将"bob-example's event"读取为肯定声明，并针对alice-example上下文标记它。数据是正确的；探测器无法解析否定。

### 3. 角色变更（需要时间意识的真阳性）

```
发现: HIGH
  A: [sources/notes/2017-03-28] advisor-example: "Partner, venture-firm-a"
  B: [people/advisor-example] advisor-example: "Senior Policy Advisor, gov-org-b"
```

在各自的时间都是正确的。2017年：venture-firm-a的partner。2025年：gov-org-b的advisor。当前的探测器正确地将其标记为矛盾，但解决方案应该是"被时间取代"而不是"一方是错的"。2017年的笔记没有错；它是历史记录。

## 场景#1：创始人追踪（最重要的一点）

这是使时间轴具有变革性而不仅仅是增量改进的使用案例：

brain包含数百个公司页面和数千个会议页面。创始人做出声明：

- "我们达到$50K MRR"（1月OH）
- "我们达到$200K MRR"（4月OH）
- "我们达到$150K MRR"（7月OH — 发生了什么？）

今天，探测器会将1月vs 4月标记为矛盾。真正的信号是4月vs 7月：**声称的指标向后退了。** 这不是数据质量问题；这是情报。

时间感知探测器可以揭示：

**声明轨迹追踪：**
```
公司: Acme Corp
  2026-01: "$50K MRR" (来源: OH transcript)
  2026-04: "$200K MRR" (来源: OH transcript)
  2026-07: "$150K MRR" (来源: OH transcript) ← 检测到回归
  2026-07: "$2M ARR" (来源: investor update) ← 与MRR不一致
```

**预测vs结果：**
```
创始人: Jane Doe (Acme Corp)
  2026-01: "我们将在6月前达到$1M ARR" (来源: batch kickoff)
  2026-06: 实际ARR: $400K (来源: investor update)
  → 预测准确率: 40%
  → 模式: 在时间线上持续乐观2-3倍
```

**叙事一致性：**
```
创始人: John Smith (WidgetCo)
  2026-01: "我们的护城河是专有数据" (来源: interview)
  2026-03: "我们正在转向API优先模式" (来源: OH)
  2026-06: "我们的护城河是网络效应" (来源: Demo Day)
  → 护城河叙事在6个月内改变了3次 — 标记以供审查
```

这不是对抗性的。这是一种经验丰富的操作员在数百次对话中直觉注意到的模式。GBrain可以使其系统化。

## 场景#2：事件消歧

在短时间内发生的两个不同事件可能在摄取时混淆，因为探测器没有时间框架来说"事件A是与事件B不同的事件"。

时间感知事实将存储（合成占位符）：
```
fact: "alice-example milestone" valid_from: 2026-04-15 valid_until: 2026-04-15
fact: "alice-example event in city-a" valid_from: 2026-04-17 valid_until: 2026-04-19
fact: "bob-example milestone" valid_from: 2026-05-04 valid_until: 2026-05-04
fact: "bob-example event in city-b" valid_from: 2026-05-12 valid_until: 2026-05-12
```

探测器应将这些识别为两个具有非重叠时间窗口的不同事件，而不是关于"谁的事件"的矛盾。

## 场景#3：角色和状态变更

人们改变角色。公司改变状态。Brain记录历史。代表生产环境中观察到的案例的合成示例：

- advisor-example: venture-firm-a partner (2019) → gov-org-b advisor (2025)
- investor-example: fund-a partner → fund-b CEO (2023)
- agent-fork: provider restriction event (2026-04-04) ≠ shutdown
- fund-c: "interesting fund" (早期) → "declined" (后期) → "losing confidence" (最新)

所有这些都是正确的历史记录。探测器应将它们分类为**时间取代**而不是**矛盾**。

## 场景#4：决策追踪

取代早期框架的多步骤决策示例（合成）：
```
2026-04-24: "status: trial" (初始框架)
2026-04-25: "status: in progress" (confirmed, 不再是"trial")
2026-05-07: "status: finalized" (session record)
2026-05-11: 采取了后续行动
```

每个步骤都取代前一个。时间感知探测器将显示**演变链**而不是将每对标记为矛盾。

## 当前存在的内容

探测器已经有一些时间基础设施：

1. **`date-filter.ts`** — `shouldSkipForDateMismatch()`预过滤配对，但只检查日期是否"相隔太远"（一个粗略的启发式方法）。它不推理哪个声明更新或其中一个是否取代另一个。

2. **`auto-supersession.ts`** — 提议解决命令，检查takes上的`since_date`。但这是事后（在判断器标记矛盾之后）。判断器本身看不到日期。

3. **Facts表**有`valid_from`和`valid_until`列。这些存在但稀疏填充，探测器未使用。

4. **Takes表**有`since_date`。也是稀疏填充。

## 需要改变的内容

### 阶段1：判断器提示增强（最小的改变，最大的影响）

将源日期传递给判断器。当前的判断器提示显示两个文本块并询问"这些是否矛盾？"如果它还显示：

```
声明A (来自: 2026-04-28):
  "status: trial"

声明B (来自: 2026-05-07):
  "status: confirmed"
```

判断器可以输出`temporal_supersession`裁决而不是`contradiction`。新的裁决分类法：

- `no_contradiction` — 声明兼容
- `contradiction` — 在同一时间点真正冲突的声明
- `temporal_supersession` — 更新的声明更新/替换较旧的声明（不是错误）
- `temporal_regression` — 指标或状态向后退（潜在信号）
- `temporal_evolution` — 随时间合法变更，既不是取代也不是回归
- `negation_artifact` — 一方包含判断器误读的显式否定

### 阶段2：声明轨迹视图（新命令）

```bash
gbrain eval trajectory "Acme Corp MRR"
gbrain eval trajectory "advisor-example role"
gbrain eval trajectory "deal-x status"
```

提取关于实体+属性的所有带时间戳的声明，按时间顺序排序，检测：
- 回归（指标下降）
- 同一时间窗口内的矛盾
- 预测vs结果差距
- 叙事漂移（护城河故事改变了3次）

### 阶段3：自动`valid_from`/`valid_until`填充

在`extract_facts`期间，从源上下文推断时间界限：
- 日期为2026-04-28的会议页面 → 声明valid_from 2026-04-28
- 来自记录的takes → valid_from = 记录日期
- 导入的笔记 → valid_from = 笔记日期
- 无日期的实体页面 → valid_from = 页面创建日期（最弱的信号）

### 阶段4：创始人记分卡

特别是对于创始人，时间探测器可以生成：
- **声明准确率评分** — 他们预测的vs实际发生的
- **一致性评分** — 他们的叙事随时间有多稳定
- **增长轨迹** — 数字是否真的在移动
- **危险信号检测器** — 指标向后退，故事改变，时间线滑动

## 建议

从阶段1开始。判断器提示更改很小。它立即消除了时间误报（在生产审计中约占剩余HIGH发现的大部分），并为探测器提供了时间感知推理的新词汇。

阶段2（轨迹视图）是可以改变操作员如何使用brain进行创始人评估的功能。值得作为独立功能进行范围界定。

阶段3-4是下游的，可以等待。

## 附录：生产探测器统计（2026-05-14）

- 约107K页面，约257K文本块
- 上次运行：50个查询中约115个HIGH发现
- 手动解决后：约25个剩余发现
- 在这约25个中：大约三分之二是时间误报，其余是探测器伪影（自相矛盾、否定解析）
- 在测试的查询中没有剩余真实数据矛盾
- 在代表性实体角色查询上的新鲜定向探测器：0个矛盾（修复前是14+）
