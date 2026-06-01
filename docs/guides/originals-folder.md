# 原创文件夹

## 目标
以用户的确切措辞捕获用户的原创想法，具有深度交叉链接和完整的来源 — 让智力资本复合而不是蒸发。

## 用户获得什么
没有它：用户在对话中产生了一个卓越的框架，当会话结束时它就消失了。六个月后，他们模糊地记得这个想法，但找不到它，无法回忆起确切的措辞，也无法追踪什么影响了它。有了它：每个原创观察、论文、框架和热门话题都以逐字形式捕获在 `brain/originals/` 中，交叉链接到塑造它的人员、公司和媒体，并且永远可搜索。

## 实现

```
on user_message(message):
    # 在每条消息中检测原创想法
    if contains_original_thinking(message):
        # 作者身份测试：
        #   用户生成的想法？                   -> originals/{slug}.md
        #   用户对别人想法的独特综合？  -> originals/（综合就是原创）
        #   别人创造的世界概念？          -> concepts/{slug}.md
        #   产品或商业想法？                   -> ideas/{slug}.md

        # 步骤 1：为 slug 使用用户的确切措辞
        #   "meatsuit-maintenance-tax"
        #   不是 "biological-needs-maintenance-overhead"
        #   生动性就是概念。
        slug = slugify(user_exact_phrase)

        # 步骤 2：创建 originals 页面
        gbrain put originals/{slug} --content """
            # {用户的确切措辞}

            ## 想法
            {用户的原创想法，以其自己的话捕获。
             不要释义。不要清理语言。
             原始措辞是智力成果。}

            ## 上下文
            {是什么触发了这个想法。会议？文章？对话？
             包括激发它的来源。}
            [来源：用户、{上下文}、{日期} {时间} {时区}]

            ## 连接
            - 相关至：[[{person_slug}]] -- {它们如何连接}
            - 从中浮现：[[{meeting_slug}]] -- {讨论了什么}
            - 受影响于：[[{book_or_media_slug}]] -- {什么引起了共鸣}
            - 构建于：[[{other_original_slug}]] -- {想法如何聚集}
        """

        # 步骤 3：交叉链接到塑造想法的所有内容
        for entity in idea.influences:
            gbrain add_link originals/{slug} <entity_slug>
            gbrain add_link <entity_slug> originals/{slug}

        # 步骤 4：同步
        gbrain sync

# 什么算作原创想法：
#   - 新颖的框架（"肉类套装维护税"）
#   - 对别人工作的热门话题（综合就是原创）
#   - 跨多个实体的模式识别
#   - 对未来的预测或赌注
#   - 带有推理的逆势立场

# 什么不进入 originals/：
#   - 关于世界的事实（-> 实体页面）
#   - 别人创造的概念（-> concepts/）
#   - 产品想法（-> ideas/）
#   - 偏好（-> 代理记忆）
```

## 棘手的地方

1. **命名：生动性就是概念。** `meatsuit-maintenance-tax` 而不是 `biological-needs-maintenance-overhead`。`ambition-debt` 而不是 `deferred-career-risk-accumulation`。用户生动的措辞是智力成果。永远不要将其净化为企业用语。
2. **综合就是原创。** 用户对 Peter Thiel 的从零到一框架的看法进入 `originals/`，而不是 `concepts/`。原创部分是用户的综合、解释或异议 -- 即使底层想法来自别人。
3. **没有交叉链接的原创内容是死掉的原创内容。** 连接就是智力。关于"野心债务"的想法如果不链接到体现它的人、讨论它的会议以及影响它的书，就只是一个坟墓中的笔记。积极地进行交叉链接。
4. **Originals 形成集群。** 随着时间的推移，用户的想法相互连接。"肉类套装维护税"连接到"野心债务"连接到"创始人能量预算"。将 originals 链接到其他 originals。集群就是用户的世界观。
5. **捕获触发上下文。** 什么对话、会议、文章或时刻激发了这个想法？上下文通常和想法本身一样重要。将其包含在页面中。

## 如何验证

1. 在对话中产生一个原创想法（例如，"我称之为'野心债务'问题 -- 你每年推迟做大，复利就会对你不利"）。使用 `gbrain get originals/ambition-debt` 确认新页面出现在 `brain/originals/ambition-debt`。
2. 检查页面是否对用户确切的措辞使用标题和 slug -- 而不是净化的版本。
3. 运行 `gbrain get_links originals/ambition-debt`。确认存在到相关人员、会议或其他 originals 的交叉链接。
4. 表达对别人想法的看法（例如，"我认为 Thiel 的逆势问题是错的，因为..."）。确认它进入 `originals/`（综合就是原创），而不是 `concepts/`。
5. 运行 `gbrain search "ambition debt"`。确认 originals 页面出现在搜索结果中并且可发现。

---
*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
