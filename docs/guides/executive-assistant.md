# 执行助理模式

## 目标
利用 brain 上下文实现电子邮件分类、会议准备和日程安排 — 让每次互动都能获得完整的关系历史。

## 用户获得什么
没有它：代理机械地分类电子邮件（"你有 12 封未读"），使用通用的 LinkedIn 简介准备会议，并且在没有上下文的情况下安排日程。有了它：代理在读取电子邮件之前就知道每个发件人是谁，在每次会议前展示共享历史，并根据关系温度和开放线程提示日程安排。

## 实现

```
# 工作流 1：电子邮件分类
on email_batch(emails):
    for email in emails:
        # 步骤 1：在读取电子邮件正文之前搜索发件人
        #   Brain 上下文使分类效果提升 10 倍
        sender_page = gbrain search "{email.sender_name}"
        if sender_page:
            context = gbrain get <sender_slug>
            #   现在你知道：他们是谁，关系历史，
            #   他们关心什么，开放的线程

        # 步骤 2：加载 brain 上下文后读取电子邮件
        #   分类现在是基于信息的，而不是机械的

        # 步骤 3：根据上下文分类
        if context.relationship == "inner_circle" or context.has_open_threads:
            priority = "urgent"
        elif context.is_known_entity:
            priority = "normal"
        else:
            priority = "noise"  # 未知发件人，没有 brain 页面

        # 步骤 4：使用关系上下文起草回复
        if needs_reply(email):
            draft = compose_reply(
                email,
                context=context,           # 他们的 brain 页面
                open_threads=context.open_threads,  # 你们正在一起做什么
                relationship=context.relationship   # 语气校准
            )

# 工作流 2：会议准备
on upcoming_meeting(meeting):
    briefing = {}
    for attendee in meeting.attendees:
        # 为每个参会者搜索 brain
        results = gbrain search "{attendee.name}"
        if results:
            page = gbrain get <attendee_slug>
            briefing[attendee] = {
                "compiled_truth": page.compiled_truth,
                "last_interaction": page.timeline[0],     # 最近的一次
                "open_threads": page.open_threads,
                "relationship_temperature": page.relationship,
                "relevant_deals": gbrain get_links <attendee_slug>,
            }
        else:
            briefing[attendee] = "没有 brain 页面 -- 考虑丰富"

    # 展示：共享历史，需要跟进的内容，需要注意的内容
    # "上次你讨论了 B 轮时间表。Pedro 担心
    #  燃烧率。这是他公司页面的最新信息。"

# 工作流 3：收件箱后的 Brain 更新
on inbox_cleared():
    for email in processed_emails:
        if email.contained_new_information:
            # 使用新信号更新发件人的 brain 页面
            gbrain add_timeline_entry <sender_slug> \
                --entry "电子邮件回复：{subject}。关键信息：{extracted_signal}" \
                --source "来自 {sender} 的电子邮件，关于 {subject}，{date}"

            # 也更新任何提到的实体页面
            for entity in email.mentioned_entities:
                gbrain add_timeline_entry <entity_slug> \
                    --entry "{what_was_said_about_them}" \
                    --source "来自 {sender} 的电子邮件，{date}"

# 工作流 4：日程安排提示
on schedule_request(meeting):
    for attendee in meeting.attendees:
        page = gbrain get <attendee_slug>
        if page.last_interaction > 6_weeks_ago:
            nudge("你已经 {weeks} 周没有与 {attendee} 会面了")
        if page.has_open_threads:
            nudge("{attendee} 有一个关于 {topic} 的开放线程")
        if page.relationship_temperature == "cooling":
            nudge("与 {attendee} 的关系可能需要关注")
```

## 棘手的地方

1. **在读取电子邮件之前搜索发件人。** 这是反直觉的但至关重要。首先加载 brain 上下文意味着你知道他们是谁，你们一起在做什么，以及他们关心什么 — 甚至在看到主题行之前。分类是基于信息的，而不是机械的。
2. **没有 brain 页面的未知发件人几乎总是噪音。** 如果 `gbrain search` 对发件人返回空，他们可能不重要。分类为低优先级，除非电子邮件内容发出其他信号。
3. **会议准备是投资回报率最高的 EA 工作流。** 用户走进每次会议时都已经了解了每个参会者：上次互动，开放线程，关系历史。这就是"你 3 点有会议"和"你 3 点有会议与 Pedro — 上次你讨论了 B 轮，他担心燃烧率"之间的区别。
4. **收件箱后的 brain 更新是 brain 复合的地方。** 每封电子邮件都是信号。如果你在不更新 brain 页面的情况下清除收件箱，信息就会丢失。这是大多数代理跳过的一步。
5. **日程安排提示需要时间线数据。** "你已经 6 周没有与 Diana 会面了"只有在会议页面已经通过适当的实体传播被摄取时才有效（参见会议摄取指南）。

## 如何验证

1. 为明天的日历运行会议准备。对于每个参会者，确认代理在生成简报之前运行了 `gbrain search` 并加载了他们的 brain 页面。
2. 分类 5 封电子邮件。确认代理在对电子邮件进行分类之前在 brain 中搜索了每个发件人。
3. 清除收件箱后，使用 `gbrain get <slug>` 检查 2 个发件人的 brain 页面。确认使用来自电子邮件的信息添加了新的时间线条目。
4. 检查日程安排建议。确认代理在提示中引用了参会者的 brain 页面（上次互动日期，开放线程）。
5. 从有 brain 页面的人那里发送测试电子邮件。确认分类响应引用了他们的关系上下文，而不仅仅是电子邮件内容。

---
*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
