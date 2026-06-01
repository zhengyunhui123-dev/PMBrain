# 来源归属

## 目标

Brain 中的每个事实都追溯到它来自哪里 — 谁说的，在什么上下文中，以及何时。

## 用户获得什么

如果没有这个：从现在起六个月，有人读取 brain 页面，不知道"Pedro 共同创立了 Brex"是来自 Pedro 本人、LinkedIn 抓取还是幻觉。有了这个：每个声明都是可审计的，冲突被浮出水面，brain 是现实的可接受法庭记录。

## 实施

```
on brain_write(page, fact):
    # 每个事实都获得引用 — 编译的真相和时间线
    citation = format_citation(source)
    #   格式：[来源：{谁}，{渠道/上下文}，{日期} {时间} {时区}]

    # 特定类别的格式：
    if source.type == "direct":
        # [来源：用户，直接消息，2026-04-07 12:33 PM PT]
    elif source.type == "meeting":
        # [来源：会议记录 "团队同步" #12345，2026-04-03 12:11 PM PT]
    elif source.type == "api_enrichment":
        # [来源：Crustdata LinkedIn 丰富，2026-04-07 12:35 PM PT]
    elif source.type == "social_media":
        # 必须包含完整 URL — 不仅仅是 @handle
        # [来源：X/@pedroh96 推文，产品发布，2026-04-07](https://x.com/pedroh96/status/...)
    elif source.type == "email":
        # [来源：来自 Sarah Chen 的电子邮件，关于 Q2 董事会套牌，2026-04-05 2:30 PM PT]
    elif source.type == "workspace":
        # [来源：Slack #engineering，Keith 关于部署计划，2026-04-06 11:45 AM PT]
    elif source.type == "web":
        # [来源：Happenstance 研究，2026-04-07 12:35 PM PT]
    elif source.type == "published":
        # [来源：[华尔街日报，2026-04-05](https://wsj.com/...)]
    elif source.type == "funding":
        # [来源：Captain API 资助数据，2026-04-07 2:00 PM PT]

    # 将引用附加到事实内联
    gbrain put <slug> --content "...事实 [来源：...]..."

    # 当来源冲突时，注意两者 — 永远不要悄无声息地选择一个
    if conflicts_exist(fact, existing_page):
        append_to_compiled_truth(
            "冲突：来源 A 说是 X，来源 B 说是 Y。"
            "[来源：A] [来源：B]"
        )

# 冲突解决的来源优先级（最高权威优先）：
SOURCE_PRIORITY = [
    "用户直接陈述",      # 1 -- 总是赢
    "主要来源",             # 2 -- 会议、电子邮件、直接对话
    "丰富 API",             # 3 -- Crustdata、Happenstance、Captain
    "网络搜索结果",          # 4
    "社交媒体帖子",          # 5
]
```

## 棘手的地方

1. **编译的真相也不能免除引用。** 综合部分中的"Pedro 共同创立了 Brex"需要 `[来源：...]`，就像时间线条目一样。大多数代理在栏上方跳过引用。
2. **推文 URL 是强制性的。** `[来源：X/@handle 推文，主题，日期]` 没有 URL 是一个损坏的引用。当省略 URL 时，数百个 brain 页面以无法访问的推文引用结束。始终：`[来源：X/@handle 推文，主题，日期](https://x.com/handle/status/ID)`。
3. **"用户说的"不够。** 在哪里，关于什么，何时。`[来源：用户，直接消息，2026-04-07 12:33 PM PT]` — 不仅仅是 `[来源：用户]`。
4. **不要悄无声息地解决冲突。** 当用户说一件事而 API 说另一件事时，在编译的真相中用两个引用注意矛盾。让读者决定。
5. **时间线条目也需要来源。** 对时间线的每次附加都带有来源。没有来源的时间线条目是孤儿事实。

## 如何验证

1. 使用 `gbrain get <slug>` 打开任何 brain 页面。读取栏上方的编译真相部分。每个事实声明都应该有一个内联 `[来源：...]` 引用。
2. 搜索推文引用：`gbrain search "X/@"`。每个结果都应该有完整的 URL，而不仅仅是 @handle。
3. 找到一个具有来自多个来源的数据的页面（例如，通过 API 丰富并在会议中提及的人员）。确认两个来源都独立引用。
4. 在 3 个随机页面上检查时间线条目。每个条目都应该有带有日期和上下文的来源引用。
5. 查找用户陈述了与 API 结果相矛盾的内容的页面。确认注意到了矛盾，而不是悄无声息地解决。

---
*属于 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
