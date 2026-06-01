# Brain-Agent 循环

## 目标

每次对话都使 brain 更聪明。每次 brain 查找都使响应更好。这个循环每天复合。

## 用户获得什么

没有它：agent 从过时的上下文中回答。你在周一讨论一笔交易，到周五 agent 已经忘记了。每次对话都从零开始。

有了它：六个月后，agent 知道的关于你的世界的东西比你能在工作记忆中保持的还要多。它永远不会忘记。它永远不会停止索引。

## 循环

```
信号到达（消息、会议、电子邮件、推文、链接）
  │
  ▼
检测实体（人员、公司、概念、原创想法）
  │  → 生成子 agent（参见 entity-detection.md）
  │
  ▼
读取：首先检查 brain（在响应之前）
  │  → gbrain search "{entity name}"
  │  → gbrain get {slug}（如果你知道它）
  │  → gbrain query "我们对 {topic} 了解什么"
  │
  ▼
响应：使用 brain 上下文（每个答案都因上下文而更好）
  │
  ▼
写入：更新 brain 页面（新信息 → 编译的真相 + 时间线）
  │  → gbrain put {slug}（更新页面）
  │  → add_timeline_entry（附加到时间线）
  │  → add_link（交叉引用到其他实体）
  │
  ▼
同步：gbrain 索引更改
  │  → gbrain sync --no-pull --no-embed
  │
  ▼
（下一个信号到达 — agent 现在更聪明了）
```

## 实现

### 在每个入站消息上

```
on_message(text):
  // 1. 检测（异步，不要阻塞）
  spawn_entity_detector(text)

  // 2. 读取（在编写响应之前）
  entities = extract_entity_names(text)  // 快速 regex/NER
  context = []
  for name in entities:
    results = gbrain_search(name)
    if results:
      page = gbrain_get(results[0].slug)
      context.append(page.compiled_truth)

  // 3. 响应（注入了 brain 上下文）
  response = compose_response(text, context)

  // 4. 写入（响应后，如果出现新信息）
  if response_contains_new_info(response):
    for entity in mentioned_entities:
      gbrain_add_timeline_entry(entity.slug, {
        date: today,
        summary: "讨论了 {topic}",
        source: "[来源：用户、对话、{date}]"
      })

  // 5. 同步
  gbrain_sync()
```

### 两个不变量

1. **每次读取都改进响应。** 如果你在检查他们的 brain 页面之前回答了关于一个人的问题，你给出的答案比你可能给出的要差。Brain 几乎总是有一些东西。外部 API 填补空白，它们不是从零开始的。

2. **每次写入都改进未来的读取。** 如果会议转录提到了关于一家公司的新信息，而你没有更新公司页面，你就创造了一个缺口，稍后会困扰你。

## 棘手的地方

1. **在响应之前读取，而不是之后。** 诱惑是先响应，稍后更新 brain。但 brain 上下文使响应更好。先读取。

2. **不要跳过写入步骤。** "我稍后会更新 brain" 意味着永远不会。在对话后立即写入，而上下文还是新鲜的。

3. **在每个写入批次之后同步。** 没有同步，brain 搜索索引是过时的。下一个查询不会找到你刚刚写的内容。

4. **外部 API 是后备，不是主要的。** 在 Brave Search 之前使用 `gbrain search`。在 Crustdata 之前使用 `gbrain get`。Brain 有关系历史、你自己的评估、会议转录、交叉引用。没有外部 API 能提供这些。

## 如何验证它有效

1. **提及 brain 知道的人。** 问 "我们对 {name} 了解什么？" Agent 应该搜索 brain 并返回编译的真相，而不是幻觉或执行网络搜索。

2. **讨论关于已知实体的新内容。** 说 "我听说 Acme Corp 刚刚完成了 B 轮融资。" 对话结束后，检查：Acme Corp 的 brain 页面是否有新的时间线条目？

3. **一天后询问同一个人。** Agent 应该立即提取 brain 上下文，无需你询问。如果它没有引用 brain 页面，循环就没有运行。

4. **检查同步。** 对话后，从 CLI 运行 `gbrain search "{topic}"`。新信息应该是可搜索的。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。另请参阅：[实体检测](entity-detection.md)、[Brain-First 查找](brain-first-lookup.md)*
