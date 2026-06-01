# 想法捕获：原创内容、深度和分发

## 目标

以确切的措辞捕获用户的原创想法，具有深度上下文和交叉链接，以便原创文件夹成为 brain 中价值最高的内容。

## 用户获得什么

没有它：对话中说的天才想法会消失。Agent 听到
"雄心与寿命之比从未如此破碎" 然后忘记了它。

有了它：每个原创观察都被逐字捕获，交叉链接到
塑造它的人员和想法，并评级为发布潜力。你的
智力档案随着每次对话而增长。

## 实现

```
capture_idea(message_text, source_context):

  # 1. 作者身份测试 — 这个想法属于哪里？
  if user_generated_the_idea(message_text):
      destination = "brain/originals/{slug}.md"
  elif user_synthesis_of_others(message_text):
      destination = "brain/originals/{slug}.md"  // 综合是原创的
  elif world_concept(message_text):
      destination = "brain/concepts/{slug}.md"
  elif product_or_business_idea(message_text):
      destination = "brain/ideas/{slug}.md"
  elif ghostwritten_by_user(message_text):
      destination = "brain/originals/{slug}.md"  // 在元数据中注意 ghostwriter
  elif article_about_user(message_text):
      destination = "brain/media/writings/{slug}.md"

  # 2. 使用确切措辞捕获 — 永远不要释义
  page = create_or_update(destination, {
      content: message_text,          // 逐字，不是总结
      source: source_context,         // 对话、会议、时刻
      reasoning_path: influences,     // 是什么导致了这个洞察力
      depth_context: emotional_nuance // 什么的 WHY 背后
  })

  # 3. 原创性评级（针对值得注意的想法）
  if is_notable(message_text):
      rate_originality(page, populations=[
          "general_population", "tech_industry",
          "intellectual_media", "political_establishment"
      ])

  # 4. 交叉链接（强制性 — 没有链接的原创内容是死的）
  link_to_people(page, mentioned_people)
  link_to_companies(page, mentioned_companies)
  link_to_meetings(page, source_meeting)
  link_to_media(page, influences)
  link_to_other_originals(page, related_ideas)
  link_to_concepts(page, referenced_concepts)

  # 5. 同步
  gbrain sync --no-pull --no-embed
```

### 作者身份测试

| 信号 | 目的地 |
|--------|-------------|
| 用户生成的想法 | `brain/originals/{slug}.md` |
| 用户对他人想法的独特综合 | `brain/originals/`（综合是原创的） |
| 别人创造的世界概念 | `brain/concepts/{slug}.md` |
| 产品或商业想法 | `brain/ideas/{slug}.md` |
| 用户的 ghostwritten 书籍/文章 | `brain/originals/`（在元数据中注意 ghostwriter） |
| 关于用户的文章 | `brain/media/writings/` |

### 捕获标准

**使用用户的确切措辞。** 语言就是洞察力。

"雄心与寿命之比从未如此破碎" 捕获了一些东西，而
"雄心与死亡之间的张力" 不会。不要清理它。不要释义。
生动的版本是真实版本。

**什么算作值得捕获：**
- 关于世界如何运作的原创观察
- 不同事物之间的新颖连接
- 框架和心理模型
- 模式识别时刻（"我不断在每 Y 中看到 X"）
- 带有背后推理的热门话题
- 揭示新角度的隐喻
- 关于自我或他人的情感/心理洞察力

**什么不算：**
- 常规操作消息（"ok"、"做它"）
- 没有嵌入观察的纯问题
- 回响 agent 所说的
- 确认和反应

### 深度测试

**一个不熟悉用户的陌生人能否读取此页面并理解不仅仅是他们认为什么，而且他们为什么以及他们如何到达那里？**

如果答案是否定的，它需要更多深度。包括：
- 推理路径（是什么导致了这个洞察力）
- 影响（他们正在阅读/观看/体验什么）
- 上下文（对话、会议、时刻）
- 情感或心理细微差别

### 原创性分布评级

对于值得注意的想法，跨不同人群评级原创性 0-100：

```markdown
## 原创性分布

- **普通人群：** 72/100 — 大多数人没有遇到这个框架
- **科技行业：** 45/100 — 在创业圈中常见，但对大多数人来说是新颖的
- **知识/媒体阶层：** 68/100 — 会引起共鸣，但尚未表达出来
- **政治建制：** 82/100 — 对政策思维完全陌生
```

**发布信号：** 强有力的文章候选人。最佳受众：创始人、建设者。

这告诉用户哪些想法值得转化为文章、演讲或视频，
以及哪些受众会发现它们最具新颖性。

### 深度交叉链接授权

**没有交叉链接的原创内容是死的原创内容。** 连接就是
智力。

每个原创内容**必须**链接到：
- **人员** 塑造了思维
- **公司** 该想法在其中发挥作用
- **会议** 其中讨论了它
- **书籍和媒体** 影响了它
- **其他原创内容** 它连接到（想法形成集群）
- **概念** 它建立或挑战

### 重要性过滤

在创建任何实体页面之前，检查重要性：

**为以下创建页面：**
- 你认识或以特定性讨论的人员
- 你正在评估、合作或投资的企业
- 你提及带有个人反应媒体
- 你明确参与的任何人员

**不要为以下创建页面：**
- 通用引用或经过示例
- 提及用户一次低参与度帐户
- 纯隐喻（"就像罗马帝国..."）
- 没有后续的一次性相遇

**决策：** 如果重要且没有页面存在，请使用网络搜索丰富创建完整页面。没有存根。如果你创建一个页面，请把它做好。

## 棘手的地方

1. **综合是原创的。** 当用户以新的方式连接两个现有想法时，该综合属于 `brain/originals/`，而不是 `brain/concepts/`。
   新颖的组合就是洞察力，即使组件想法不是新的。

2. **确切措辞是不可协商的。** 永远不要释义、总结或
   "清理" 用户的语言。"雄心与寿命之比从未如此破碎" 就是洞察力。"雄心与死亡之间的张力"
   是尸体。捕获第一个版本。

3. **交叉链接是强制性的，不是可选的。** 没有链接到
   塑造它的人员、公司、会议和概念的原创内容是死的
   原创内容。连接就是智力。在考虑捕获之前，请检查每个原创内容是否至少具有 2 个交叉链接。

## 如何验证

1. **生成一个想法并检查页面。** 在
   对话中说一些原创内容（例如，"如果 markdown 文件实际上是分布式
   软件怎么办？"）。验证 `brain/originals/{slug}.md` 已使用
   你的确切措辞创建，而不是释义。

2. **检查交叉链接是否存在。** 打开新创建的原创页面。它
   应该至少链接到提及的人员或概念。打开那些
   链接的页面，并验证它们反向链接到原创内容。

3. **验证深度测试通过。** 以你是
   陌生人的身份读取捕获的页面。你能否理解不仅仅是用户认为什么，而且为什么？
   如果推理路径和上下文缺失，则捕获不完整。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
