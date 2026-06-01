# 会议摄取

## 目标

会议转录成为 brain 页面，该页面更新每个提及的实体 — 与会者、公司、交易和行动项目都在一次传递中传播。

## 用户获得什么

没有它：会议消失在内存中，行动项目被遗忘，并且 agent 不知道你上次见到某人时讨论了什么。有了它：每个会议都是永久记录，它丰富了它触及的每个人员和公司页面，并且用户在每次跟进时都会带着简报走进去。

## 实现

```
on new_meeting_transcript(meeting):
    # 步骤 1：拉取完整转录 — 不是 AI 摘要
    #   AI 摘要会产生幻觉框架（"同意 that..."）
    #   转录是地面真相
    transcript = fetch_full_transcript(meeting.id)  # 例如，Circleback API
    # 必须具有说话者日记化：WHO 说了什么

    # 步骤 2：创建会议页面
    slug = f"meetings/{meeting.date}-{short_description}"
    compiled_truth = agent_analysis(transcript):
            # 在条形上方：agent 自己的分析，不是通用Recap
            #   - 通过用户的优先级重新构建
            #   - 标记惊喜、矛盾、影响
            #   - 名称真实决策（不是表演性的决策）
            #   - 说出什么被留下未说或未解决
    timeline = format_diarized_transcript(transcript)
            # 在条形下方：完整转录，仅附加
            #   格式：**说话者** (HH:MM:SS)：Words。

    gbrain put <slug> --content "<compiled_truth>\n---\n<timeline>"

    # 步骤 3：传播到所有实体页面（强制性 — 大多数 agents 跳过此步骤）
    for person in meeting.attendees + meeting.mentioned_people:
        gbrain add_timeline_entry <person_slug> \
            --entry "在 '{meeting.title}' 中遇见 on {date}。要点：..." \
            --source "会议笔记 '{meeting.title}'、{date}"

        # 如果有新信息出现，则更新他们的状态部分

    for company in meeting.mentioned_companies:
        gbrain add_timeline_entry <company_slug> \
            --entry "在 '{meeting.title}' 中讨论：{what_was_said}" \
            --source "会议笔记 '{meeting.title}'、{date}"

    # 步骤 4：提取行动项目
    action_items = extract_action_items(transcript)
    # 添加到带有负责人归属的任务列表

    # 步骤 5：反向链接所有内容（双向图形）
    for entity in all_entities_mentioned:
        gbrain add_link <slug> <entity_slug>   # 会议 -> 实体
        gbrain add_link <entity_slug> <slug>    # 实体 -> 会议

    # 步骤 6：同步，以便新页面立即可搜索
    gbrain sync
```

：cron 计划：每天 3 次（上午 10 点、下午 4 点、晚上 9 点）以捕获新会议
：来源：Circleback (https://circleback.ai) 或任何具有
       说话者日记化 + API/webhook 访问的服务

## 棘手的地方

1. **始终拉取完整转录，永远不会 AI 摘要。** AI 摘要会产生幻觉框架 — 它们会编辑什么"同意"或"决定"，而当没有此类协议发生时。日记化转录是地面真相。

2. **实体传播是大多数 agents 跳过的步骤。** 在每次与会者的页面、每个提及的人的页面和每个公司的页面都有
   新的时间线条目前，会议摄取才完成。仅会议页面
   在没有传播的情况下是无用的。

3. **提及的人员不仅仅是与会者。** 如果会议讨论了 "Sarah 在 Brex 的团队，" 那么 Sarah 的页面和 Brex 的页面都需要更新 — 即使 Sarah 不在房间里。

4. **Agent 的分析是有价值的，不是摘要。** "他们讨论了 Q2 目标" 是没有价值的。"Pedro 推回了燃烧率，Diana 没有承诺到时间线，并且没有人解决定价差距" 是有用的。

5. **反向链接必须是双向的。** 会议页面链接到与会者页面，并且与会者页面链接回会议。图形是双向的。始终。

## 如何验证

1. 摄取会议后，运行 `gbrain get meetings/{date}-{slug}`。确认页面在条形上方有其 agent 的分析，并在其下方具有完整的日记化转录。

2. 对于每个与会者，运行 `gbrain get <attendee_slug>`。检查他们的时间线是否具有引用带有特定洞察力的会议的新条目（不仅仅是 "参加会议"）。

3. 选择会议中提到的一家公司。运行 `gbrain get <company_slug>`。确认存在引用讨论了该公司内容的时间线条目。

4. 运行 `gbrain get_links meetings/{date}-{slug}`。验证是否存在到所有与会者和实体页面的反向链接。

5. 运行 `gbrain search "{meeting_topic}"`。确认会议页面出现在搜索结果中（验证同步运行）。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
