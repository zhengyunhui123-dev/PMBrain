# 确定性收集器：用于数据的代码，用于判断的 LLM

## 目标

将机械工作（100% 可靠的代码）与分析工作（LLM 判断）分开，以便确定性任务永远不会概率性地失败。

## 用户获得什么

没有它：LLM 生成 Gmail 链接、格式化表格和跟踪状态。它遵循前 10 个项目的规则，然后在第 11 个项目上丢弃链接。你在 prompt 中写"没有例外"。它仍然失败。20 个项目上 90% 的可靠性意味着每天两次可见故障。信任被破坏。

有了它：代码处理 URL、格式化和状态（100% 可靠）。LLM 读取预格式化的数据并添加判断、分类和丰富。链接永远不会错，因为 LLM 永远不会生成它们。

## 实现

```
// 模式：代码收集，LLM 分析

// 步骤 1：确定性收集器（脚本，无 LLM 调用）
collector_run():
  messages = gmail_api.fetch_unread()
  for msg in messages:
    structured = {
      id: msg.id,
      from: msg.sender,
      subject: msg.subject,
      snippet: msg.snippet,
      gmail_link: f"https://mail.google.com/mail/u/?authuser={account}#inbox/{msg.id}",
      gmail_markdown: f"[在 Gmail 中打开]({gmail_link})",
      is_signature: regex_match(msg, DOCUSIGN_PATTERNS),
      is_noise: regex_match(msg, NOISE_PATTERNS),
      is_new: msg.id not in state.seen_ids
    }
    store(structured)
    state.seen_ids.add(msg.id)
  generate_markdown_digest(structured_messages)

// 步骤 2：LLM 读取预格式化的摘要
llm_analyze():
  digest = read("data/digests/today.md")  // 链接已经烘焙进去
  classify_urgency(digest)                 // 判断调用
  add_commentary(digest)                   // 上下文分析
  run_brain_enrichment(notable_entities)   // gbrain search + 更新
  draft_replies(urgent_items)              // 创造性工作
  surface_to_user(final_output)            // 交付

// 步骤 3：连接到 cron
cron_job():
  collector_run()     // 快速、廉价、确定性
  llm_analyze()       // 较慢、昂贵、创造性
```

### 架构

```
+-----------------------------+     +------------------------------+
|  确定性收集器    |---->|       LLM Agent              |
|  (Node.js / Python 脚本)  |     |                              |
|                             |     |  - 读取预格式化的    |
|  - 从 API 拉取数据       |     |    摘要                    |
|  - 存储结构化 JSON    |     |  - 分类项目            |
|  - 生成链接/URL    |     |  - 添加评论            |
|  - 检测模式 (regex)  |     |  - 运行 brain 丰富      |
|  - 跟踪状态 (已见/新)   |     |  - 起草回复             |
|  - 输出 markdown 摘要   |     |  - 面向用户交付           |
|                             |     |                              |
|  CODE — 确定性、      |     |  AI — 判断、上下文、     |
|  永远不会忘记              |     |  创造力                  |
+-----------------------------+     +------------------------------+
```

### 文件结构

```
scripts/email-collector/
├── email-collector.mjs     # 无 LLM 调用，无外部依赖
├── data/
│   ├── state.json          # 最后拉取时间戳、已知 ID、待处理签名
│   ├── messages/           # 每天的结构化 JSON
│   │   └── 2026-04-09.json
│   └── digests/            # 预格式化的 markdown
│       └── 2026-04-09.md
```

### 模式适用的地方

| 信号源 | 收集器生成 | LLM 添加 |
|--------------|-------------------|----------|
| **电子邮件** | Gmail 链接、发件人元数据、签名检测 | 紧急程度分类、丰富、回复草稿 |
| **X/Twitter** | 推文链接、参与指标、删除检测 | 情感分析、叙事检测、内容想法 |
| **日历** | 事件链接、出席者列表、冲突检测 | 准备简报、来自 brain 的会议上下文 |
| **Slack** | 频道链接、线程链接、提及检测 | 优先级分类、行动项提取 |
| **GitHub** | PR/issue 链接、diff 统计、CI 状态 | 代码审查上下文、优先级评估 |

### 原则

如果一条输出必须存在并且每次都必须正确格式化，请在代码中生成它。如果一条输出需要判断、上下文或创造力，请使用 LLM 生成它。不要要求 LLM 在同一次传递中同时执行这两个操作。

## 棘手的地方

1. **LLM 会忘记链接 — 在代码中烘焙它们。** LLM 将遵循前 10 个项目的"包含 Gmail 链接"规则，然后在第 11 个项目上默默地丢弃它。无论你进行多少 prompt 工程，都无法修复长输出上的概率格式化。修复：在收集器脚本中生成每个链接。LLM 读取预格式化的 markdown，其中链接已经嵌入。它无法忘记它没有生成的东西。

2. **噪声过滤必须是确定性的。** 基于 regex 的噪声检测（新闻通讯、自动收据、营销）属于收集器，而不是 LLM。LLM 可能在一次运行中将新闻通讯分类为"可能重要"，而在下一次运行中将分类为"噪声"。代码每次都以相同的方式分类相同的输入。

3. **原子写入防止损坏。** 收集器写入一个状态文件（`state.json`），该文件跟踪已看到哪些消息。如果脚本在写入中途崩溃，状态文件可能会损坏。首先写入临时文件，然后原子地重命名。这也可以防止 cron 在收集运行期间触发时 LLM 读取部分摘要。

## 如何验证

1. **运行收集器并检查每个链接。** 手动执行收集器脚本。打开生成的摘要。单击每个 `[在 Gmail 中打开]` 链接（或等效项）。每个链接必须解析到正确的项目。如果有任何链接损坏或丢失，收集器就有 bug。

2. **验证噪声过滤是一致的。** 对相同的输入数据运行收集器两次。噪声分类（is_noise 字段）两次必须相同。如果它变化，说明概率元素泄漏到了确定性层中。

3. **验证 LLM 读取结构化输出。** 运行完整管道（收集器然后 LLM）。检查 LLM 的分析是否引用了来自结构化摘要的数据，而不是来自它自己的生成。最终输出中的链接应该与摘要文件中的链接相同。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
