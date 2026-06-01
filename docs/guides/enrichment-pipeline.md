# 丰富管道

## 目标

使用分层支出从外部 API 丰富 brain 页面 — 关键人员使用完整管道，短暂提及使用轻度接触，保留原始数据以供审计。

## 用户获得什么

没有它：brain 页面是仅包含用户手动键入内容的单薄 shell，API 调用被浪费在 nobodies 上，并且丰富数据在 agent 会话结束后消失。有了它：关键人员拥有丰富的多来源肖像；支出扩展到重要性；原始 API 响应被保留以供重新处理；并且交叉引用连接整个图形。

## 实现

```
on enrich(entity, trigger):
    # 触发器：会议提及、电子邮件线程、社交互动、用户请求

    # 步骤 1：从传入信号中识别实体
    entities = extract_entities(signal)
    #   人员名称、公司名称、关联

    # 步骤 2：检查 brain 状态 — 更新或创建路径？
    for entity in entities:
        existing = gbrain search "{entity.name}"
        if existing:
            page = gbrain get <entity_slug>
            path = "UPDATE"
        else:
            path = "CREATE"

    # 步骤 3：确定层级 — 将支出扩展到重要性
    tier = classify_tier(entity):
        # 层级 1（10-15 次 API 调用）：关键人员、内圈、业务合作伙伴、
        #         投资组合公司。完整管道，所有数据源。
        # 层级 2（3-5 次 API 调用）：值得注意的人员、偶尔的互动。
        #         网络搜索 + 社交 + brain 交叉引用。
        # 层级 3（1-2 次 API 调用）：轻微提及，其他所有值得跟踪的。
        #         Brain 交叉引用 + 如果已知句柄则进行社交查找。

    # 步骤 4：运行外部查找（优先级顺序，当有足够信号时停止）
    data = {}
    data["brain"] = gbrain search "{entity.name}"          # 始终第一（免费）
    if tier <= 2:
        data["web"] = brave_search("{entity.name}")        # 背景、新闻、演讲
    if tier <= 2:
        data["twitter"] = twitter_lookup(entity.handle)    # 信念、构建、网络
    if tier == 1:
        data["linkedin"] = crustdata_enrich(entity.name)   # 职业、连接
        data["research"] = happenstance_research(entity)   # 职业弧线、网络存在
        data["funding"] = captain_api(entity.company)      # 资金、估值、团队
        data["meetings"] = circleback_search(entity.name)  # 转录搜索
        data["contacts"] = google_contacts(entity.email)   # 联系数据

    # 步骤 5：存储原始数据（可审计，可重新处理）
    gbrain put_raw_data <entity_slug> \
        --data '{"sources": {"crustdata": {"fetched_at": "...", "data": {...}}, ...}}'
    # 在重新丰富时覆盖，不要附加

    # 步骤 6：写入 brain 页面
    if path == "CREATE":
        gbrain put <entity_slug> --content "<compiled_truth_from_all_sources>"
        gbrain add_timeline_entry <entity_slug> --entry "通过丰富创建的页面"
    elif path == "UPDATE":
        # 附加时间线，仅当有实质性新内容时才更新编译真相
        gbrain add_timeline_entry <entity_slug> --entry "丰富：{new_signal}"
        # 标记矛盾 — 不要默默地解决它们

    # 步骤 7：交叉引用图形
    gbrain add_link <person_slug> <company_slug>       # 人员 -> 公司
    gbrain add_link <company_slug> <person_slug>       # 公司 -> 人员
    gbrain add_link <person_slug> <deal_slug>          # 人员 -> 交易
    # 每个实体页面都链接到引用它的每个其他实体页面
```

# 人员页面部分（不是 LinkedIn 个人资料 — 活的肖像）：
#   执行摘要、状态、他们的信念、他们在构建什么、
#   他们的动机、评估、轨迹、关系、联系方式、时间线
# 事实是桌面筹码。纹理是有价值的东西。

# 提取纹理，不仅仅是事实：
#   表达的意见？        -> 他们的信念
#   构建或发布？     -> 他们在构建什么
#   表达的情感？        -> 什么让他们打勾
#   他们与谁互动？ -> 网络 / 关系
#   重复出现的主题？          -> 爱好马
#   承诺做某事？   -> 开放线程
#   能量水平？             -> 轨迹

## 棘手的地方

1. **不要覆盖人工编写的评估。** 如果用户用他们自己对某人的解读编写了评估部分，API 丰富永远不会覆盖它。API 数据进入状态、联系方式、时间线。用户的评估是神圣不可侵犯的。

2. **不要每周多次重新丰富同一页面。** 在再次运行管道之前，检查 `put_raw_data` 时间戳。丰富是昂贵的，数据不会变得那么快。

3. **LinkedIn 连接数 < 20 意味着错误的人。** Crustdata 有时会返回同名的不同人员。如果 LinkedIn 个人资料的连接数少于 20 个，那几乎可以肯定是不匹配的。丢弃它。

4. **X/Twitter 是评价最低的数据源。** 当你有某人的句柄时，他们的推文会揭示信念、他们在构建什么、爱好马、网络（回复模式）和轨迹（发布频率、语气变化）。这对于"他们的信念"和"什么让他们打勾"比 LinkedIn 更丰富。

5. **交叉引用不是可选的。** 在丰富人员之后，更新他们的公司页面。在丰富公司之后，更新创始人页面。没有交叉链接的丰富页面是图形中的死胡同。

## 如何验证

1. 丰富一个层级 1 人员。运行 `gbrain get <slug>` 并确认页面具有来自多个来源的执行摘要、状态、他们的信念、联系方式和时间线部分。
2. 运行 `gbrain get_raw_data <slug>`。确认原始 API 响应与 `sources.{provider}.fetched_at` 时间戳一起存储。
3. 运行 `gbrain get_links <slug>`。确认存在到人员公司页面、交易页面和相关实体的交叉引用链接。
4. 检查一个已丰富并且具有用户编写的评估的页面。确认评估部分被保留，没有被 API 数据覆盖。
5. 尝试重新丰富同一个人。确认系统检查 `fetched_at` 时间戳，如果小于一周则跳过。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
