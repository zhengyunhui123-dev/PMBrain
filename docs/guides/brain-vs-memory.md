# Brain vs 记忆 vs 会话

## 目标

知道什么进入 GBrain，什么进入 agent 记忆，以及什么停留在会话上下文中 — 以便每条信息都落在正确的层。

## 用户获得什么

没有它：人员档案存储在 agent 记忆中（在 agent 重置时丢失），用户偏好存储在 GBrain 中（混乱知识页面），并且 agent 重新询问它已经知道答案的问题。有了它：世界知识持久化在 brain 中，操作状态持久化在 agent 记忆中，并且 agent 永远不会将信息放在错误的层。

## 实现

```
on new_information(info):
    # 三个层，三个目的 — 路由到正确的那个

    if info.is_about_the_world:
        # GBRAIN：人员、公司、交易、会议、概念、想法
        # 这是世界知识 — 关于 agent 外部实体的事实
        gbrain put <slug> --content "..."
        # 示例：
        #   "Pedro 是 Brex 的 CEO"           -> gbrain（人员页面）
        #   "Brex 以 $12B 完成了 D 轮融资"   -> gbrain（公司页面）
        #   "周二的会议涵盖了 Q2"   -> gbrain（会议页面）
        #   "肉类套装维护税"   -> gbrain（原创页面）

    elif info.is_about_operations:
        # AGENT MEMORY：偏好、决策、工具配置、会话连续性
        # 这是 agent 如何操作的 — 不是关于世界的事实
        memory_write(info)
        # 示例：
        #   "用户更喜欢简洁的格式"      -> agent 记忆
        #   "在 prod 之前部署到 staging"        -> agent 记忆
        #   "在代码块中使用暗黑模式"         -> agent 记忆
        #   "Crustdata 的 API 密钥放在 .env 中"   -> agent 记忆

    elif info.is_current_conversation:
        # SESSION CONTEXT：刚才说了什么，当前任务，即时状态
        # 这是自动的 — 已经在会话窗口中
        # 不需要存储操作
        # 示例：
        #   "我们刚才在讨论 board deck"  -> session
        #   "你要求我审查这个 PR"          -> session
        #   "我刚刚分享的文件"                  -> session

# 查找路由：
on user_asks(question):
    if question.about_person or question.about_company or question.about_meeting:
        gbrain search "{entity}"    # -> 世界知识
        gbrain get <slug>

    elif question.about_preference or question.about_how_to_operate:
        memory_search("{topic}")    # -> 操作状态

    elif question.about_current_context:
        # 已经在 session 中 — 只引用会话历史
        pass
```

## 棘手的地方

1. **不要将人员存储在 agent 记忆中。** "Pedro 更喜欢电子邮件而不是 Slack" 感觉像是偏好，但它是关于 Pedro 的事实 — 它放在 GBrain 中 Pedro 的页面上。Agent 记忆用于 agent 自己的操作状态，而不是关于世界上人员的事实。

2. **不要将用户偏好存储在 GBrain 中。** "用户喜欢项目符号而不是段落" 是关于 agent 应该如何行为的，而不是关于世界的。它放在 agent 记忆中。GBrain 页面用于实体，不用于 agent 配置。

3. **外部想法的综合放在 GBrain 中。** "用户对 Peter Thiel 的从零到一框架的看法" 是用户的原创想法 — 它放在 GBrain 中 originals/ 下，而不是在 agent 记忆中。

4. **Agent 记忆在一些平台上不会在 agent 重置后幸存。** 关键的世界知识必须放在 GBrain 中，它是持久的。如果 agent 丢失了记忆，brain 仍然拥有所有东西。

5. **当有疑问时，问：这是关于世界的还是关于如何操作的？** 世界 -> GBrain。操作 -> agent 记忆。当前对话 -> session。

## 如何验证

1. 询问 agent "谁是 Pedro？" — 确认它运行了 `gbrain search` 或 `gbrain get`，而不是 `memory_search`。人员查找应该命中 GBrain。
2. 询问 agent "我应该如何格式化响应？" — 确认它检查 agent 记忆，而不是 GBrain。偏好是操作状态。
3. 检查 agent 记忆存储中不存在任何人员或公司页面。运行 `memory_search "person"` — 它应该返回偏好，而不是档案。
4. 检查 GBrain 不包含关于 agent 行为的页面。运行 `gbrain search "user prefers"` — 它应该不返回任何内容（偏好属于 agent 记忆）。
5. 在 agent 重置后，确认 GBrain 知识仍然可访问。运行 `gbrain get <any_slug>` — 世界知识应该在重置后幸存。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
