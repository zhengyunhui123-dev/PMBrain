# 操作纪律

## 目标
五个不容谈判的规则，用于区分生产级 brain 和演示版 — 信号检测、brain-first 查找、每次写入后同步、每日心跳和夜间梦境循环。

## 用户获得什么
没有它：代理在对话中错过信号，在 brain 已有答案时浪费外部 API 费用，写入后搜索结果过时，并且让 brain 悄然腐烂。有了它：每条消息都会扫描实体，brain 始终首先被查询，搜索始终是最新的，健康状况每天被监控，并且 brain 在夜间复合增长。

## 实现

```
# 纪律 1：每条消息上的信号检测（强制性）
on every_inbound_message(message):
    # 没有例外。如果用户大声思考而 brain 没有
    # 捕获它，系统就被破坏了。这是 #1 纪律。

    entities = detect_entities(message)
    #   人员、公司、交易、原创想法

    for entity in entities:
        existing = gbrain search "{entity.name}"
        if existing:
            gbrain add_timeline_entry <entity_slug> \
                --entry "{what_was_said}" \
                --source "User, direct message, {timestamp}"
        # 否则：如果足够重要，标记为丰富

    originals = detect_original_thinking(message)
    for idea in originals:
        gbrain put originals/{slug} --content "{user's exact phrasing}"

# 纪律 2：在外部 API 之前 Brain-First 查找（强制性）
on information_needed(topic):
    # 始终在接触网络之前检查 brain
    brain_result = gbrain search "{topic}"
    if brain_result:
        page = gbrain get <slug>
        # 首先使用 brain 数据。外部 API 填补空白，不替换。
    else:
        # Brain 没有内容 -- 现在使用外部 API
        external_result = brave_search("{topic}")

    # 在检查自己的 brain 之前就接触网络的代理
    # 是在浪费金钱并提供更差的答案。

# 纪律 3：每次写入后同步（强制性）
on brain_write_complete():
    gbrain sync
    # 没有这个，搜索结果会过时。
    # 你刚刚写入的页面不会出现在 gbrain search 或 gbrain query 中
    # 直到同步运行。跳过这个意味着下次查找会错过
    # 最近的数据。

# 纪律 4：每日心跳检查
on daily_schedule("09:00"):
    gbrain doctor
    # 检查：数据库连接性、嵌入健康状况、同步状态、
    # 页面计数、过时页面、损坏的链接
    # 如果 doctor 报告问题，在做什么其他事情之前修复它们。

# 纪律 5：夜间梦境循环
on nightly_schedule("02:00"):
    # 梦境循环是最重要的纪律。
    # Brain 在夜间复合增长。

    # 5a：实体扫描 -- 查找未链接的提及
    pages = gbrain list_pages
    for page in pages:
        mentions = extract_entity_mentions(page.content)
        existing_links = gbrain get_links <page.slug>
        for mention in mentions:
            if mention not in existing_links:
                gbrain add_link <page.slug> <mention_slug>  # 修复损坏的图形

    # 5b：引用审计 -- 查找没有来源的事实
    for page in pages:
        facts_without_sources = audit_citations(page.content)
        if facts_without_sources:
            flag_for_remediation(page, facts_without_sources)

    # 5c：记忆巩固 -- 从时间线更新编译真相
    for page in stale_pages(older_than="7d"):
        timeline = gbrain get_timeline <page.slug>
        if timeline.has_new_entries_since_last_consolidation:
            # 从累积的时间线重新综合编译真相
            updated_truth = consolidate(page.compiled_truth, timeline.new_entries)
            gbrain put <page.slug> --content updated_truth

    # 5d：同步所有内容
    gbrain sync

# 奖励：持久技能优于一次性工作
# 如果你做了两次，就把它变成技能和 cron。
#   1. 概念化过程
#   2. 手动运行 3-10 个项目
#   3. 修订 -- 迭代质量
#   4. 编入技能
#   5. 添加到 cron -- 自动化它
# 每种实体类型和信号源都恰好有一个所有者技能。
# 两个技能创建同一个页面 = 覆盖违规。
```

## 棘手的地方

1. **梦境循环是最重要的纪律。** Brains 在夜间复合增长。实体扫描修复损坏的图形，引用审计捕获无来源的事实，记忆巩固保持编译真相的最新状态。跳过梦境循环，brain 会慢慢腐烂。
2. **跳过纪律 3（写入后同步）意味着过时的搜索结果。** 你写入一个页面，然后立即搜索它 -- 什么也找不到。页面存在但未被索引。始终在写入后同步。
3. **信号检测必须在每条消息上触发。** 不仅仅是在看起来重要的消息上。用户顺便说"我昨天和 Pedro 讨论了董事会席位" -- 那是 Pedro 页面上的时间线条目，他的状态部分的潜在更新，以及关于董事会的信号。如果代理没有捕获它，系统就被破坏了。
4. **Brain-first 节省金钱并提供更好的答案。** Brain 拥有外部 API 所没有的上下文：关系历史、会议记录、用户自己的评估。对"Pedro Franceschi"的 API 查找返回 LinkedIn 个人资料。Brain 返回完整的画面，包括私人上下文。
5. **`gbrain doctor` 捕获静默失败。** 嵌入管道可能停滞，同步可能静默失败，数据库连接可能断开。每日心跳在它们复合造成数据丢失之前捕获这些。

## 如何验证

1. 发送提及有 brain 页面的人的消息。确认代理检测到实体并将其添加到他们页面的时间线条目（`gbrain get_timeline <slug>`）。
2. 询问代理关于 brain 中的某人。确认它在接触外部 API 之前运行 `gbrain search` 或 `gbrain get`（检查工具调用顺序）。
3. 使用 `gbrain put` 写入新页面，然后立即运行 `gbrain search` 来搜索它。确认它出现在结果中（验证同步运行）。
4. 运行 `gbrain doctor`。确认它返回包含数据库状态、页面计数和任何标记问题的健康报告。
5. 梦境循环运行后，检查具有未链接实体提及的页面。确认添加了新链接（`gbrain get_links <slug>`）。

---
*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
