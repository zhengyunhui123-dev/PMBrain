# Takes vs Facts — 架构区分

gbrain有两个认识论存储层，服务于不同的目的。**永远不要混淆它们。**

## Takes（冷存储 — `takes`表）

认识论层。WHO相信WHAT，带有置信权重和时间。

- **来源：** 通过LLM分析从brain页面（markdown）提取
- **范围：** 多持有者 — 捕获来自*任何*发言者的信念，而不仅仅是brain所有者
- **种类：** `take`（意见），`fact`（可验证），`bet`（预测），`hunch`（直觉）
- **生命周期：** 冷存储，回顾性。当页面更改或重新提取运行时更新。
- **规模：** 在成熟的brain中，跨数千个持有者超过100K+行

**Takes示例：**
- `holder=people/garry-tan kind=bet` "AI will replace 50% of coding by 2030" (w=0.75)
- `holder=people/jared-friedman kind=take` "Momo has strong retention" (w=0.80)
- `holder=world kind=fact` "Clipboard raised $100M Series C" (w=1.0)
- `holder=brain kind=hunch` "Garry has a hero/rescuer pattern" (w=0.70)

**查询表面：** `gbrain takes list`, `gbrain takes search`, `gbrain think`

## Facts（热内存 — `facts`表，v0.31）

来自brain所有者对话的个人知识。实时捕获。

- **来源：** 通过facts hook（Haiku）逐轮次从对话中提取
- **范围：** 单用户 — 仅限brain所有者的陈述知识
- **种类：** `event`, `preference`, `commitment`, `belief`, `fact`
- **生命周期：** 热存储，实时。在对话发生时捕获。
- **桥接：** Dream周期`consolidate`阶段每晚将热facts提升为冷takes

**Facts示例：**
- `kind=event` "I have a meeting with Brian tomorrow"
- `kind=preference` "I don't drink coffee"
- `kind=commitment` "We decided on nesting custody"
- `kind=belief` "I think the market is overheated"

**查询表面：** `gbrain recall`, MCP `_meta.brain_hot_memory`

## 类别错误

**永远不要将takes转储到facts表中。** Takes包括其他人的归因信念（Jared对公司评估，PG对学校看法，创始人的收入声明）。这些**不是**brain所有者的个人facts。

**永远不要在没有转换的情况下将facts转储到takes表中。** Facts的范围限定于所有者在对话中说的内容。它们只有通过dream周期的consolidate阶段才成为takes，该阶段添加适当的归因、去重和时间推理。

## 桥接

Dream周期的`consolidate`阶段（v0.31）是单向桥：

```
hot facts → [dream consolidate] → cold takes
```

Facts仅向**一个方向**流动。Consolidate阶段：
1. 按实体分组相关facts
2. 针对现有takes进行去重
3. 将持久facts提升为具有适当holder/weight的takes
4. 用`consolidated_at` + `consolidated_into`标记已合并的facts

## 生产提取数据（2026-05-10）

在约100K页面的brain上首次完整takes提取运行：
- **模型：** Azure GPT-5.5（以1/8成本达到Opus质量 — 每页$0.033 vs $0.260）
- **结果：** 来自28,256个磁盘页面的100,720个takes，$361.49，83个错误（0.3%）
- **细分：** 70,960个takes / 24,342个facts / 2,875个bets / 2,649个hunches
- **持有者：** 6,239个唯一持有者
- **跨模态评估：** 总体6.8/10（GPT-5.5 + Opus 4.6独立评分）

### 评估维度

| 维度 | 分数 | 备注 |
|-----------|-------|-------|
| Accuracy | 7.5 | 声明忠实于来源 |
| Attribution | 6.5 | Holder/subject混淆是#1问题 |
| Weight calibration | 7.0 | 良好的范围使用，一些错误的精度 |
| Kind classification | 6.5 | 偶尔fact/take分类错误 |
| Signal density | 6.5 | 一些琐碎的提取通过 |

### 提取提示的关键学习

1. **Holder ≠ subject.** "Garry has a hero/rescuer pattern" → holder=brain, NOT people/garry-tan
2. **原子声明。** 将复合声明拆分为单独的行
3. **放大 ≠ 认可.** 仅转发 → 最大权重0.55
4. **自报告 ≠ 已验证.** "Reports 7 figures" → holder=person, weight=0.75, NOT world/1.0
5. **无错误精度.** 使用0.05增量（0.35, 0.55, 0.75），而不是0.74或0.82
6. **"So what"测试.** 跳过Twitter句柄，粉丝数，明显的元数据
