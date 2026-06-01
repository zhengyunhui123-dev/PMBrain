# 内容和媒体摄取

## 目标

YouTube 视频、社交媒体、PDF 和文档变成可搜索的 brain 页面，带有 agent 自己的分析和对每个提到的实体的完整交叉引用。

## 用户获得什么

没有它：媒体链接是衰减的书签 — 你记得观看了一个视频，但无法找到说了什么、谁说的或为什么它重要。有了它：每个媒体都是一个永久的 brain 页面，顶部有 agent 的分析层，每个提到的实体都获得反向链接，并且完整内容永远可搜索。

## 实现

```
on user_shares_media(url_or_file):

    # 模式 1：YouTube 视频摄取
    if media.type == "youtube":
        # 步骤 1：获取带有说话者日记化的完整转录
        #   WHO 说了什么 — 不仅仅是一面文本墙
        #   使用 Diarize.io 或等效服务
        transcript = diarize(video_url)  # 说话者归属的转录
        # 永远不要使用 YouTube 的自动生成摘要或 AI 摘要

        # 步骤 2：Agent 写入自己的分析（这是价值所在）
        #   不是摘要。不是 regurgitation。Agent 的 TAKE：
        #   - 什么重要以及为什么（给定用户的世界观）
        #   - 归属于特定说话者的关键引用
        #   - 与现有 brain 页面的连接
        #   - 影响和后续角度
        analysis = agent_analyze(transcript, user_context)

        # 步骤 3：创建 brain 页面
        slug = f"media/youtube/{video_slug}"
        gbrain put <slug> --content """
            # {title}
            **频道：** {channel} | **日期：** {date} | **链接：** {url}

            ## 分析
            {agent_analysis}

            ## 关键引用
            - **{Speaker}** ({timestamp}): "{quote}" -- {why_it_matters}

            ---

            ## 完整转录
            {diarized_transcript}
        """

        # 步骤 4：提取和交叉引用实体
        for person in transcript.mentioned_people:
            gbrain add_link <slug> <person_slug>
            gbrain add_link <person_slug> <slug>
            gbrain add_timeline_entry <person_slug> \
                --entry "在 {video_title} 中讨论：{what_was_said}" \
                --source "YouTube: {url}"

    # 模式 2：社交媒体捆绑
    elif media.type == "tweet" or media.type == "social":
        # 不要只保存一条推文 — 重建完整上下文
        bundle = {
            "original": fetch_tweet(url),
            "thread": reconstruct_thread(url),        # 引用的推文、回复
            "linked_articles": fetch_linked_urls(),    # 获取并总结
            "engagement": get_engagement_data(),       # 什么引起了共鸣
        }

        slug = f"media/social/{platform}-{author}-{date}"
        gbrain put <slug> --content """
            # {author}: {topic}
            {agent_analysis_of_full_bundle}

            ## 线程
            {reconstructed_thread}

            ## 链接的文章
            {article_summaries}

            ---

            ## 原始
            {original_tweet_text}
        """

        # 提取实体和交叉引用
        for entity in bundle.mentioned_entities:
            gbrain add_link <slug> <entity_slug>
            gbrain add_link <entity_slug> <slug>

    # 模式 3：PDF 和文档
    elif media.type == "pdf" or media.type == "document":
        # 如果需要，进行 OCR（扫描的 PDF）
        content = ocr_if_needed(file) or extract_text(file)

        # 对于书籍和长篇幅：
        slug = f"sources/{document_slug}"
        gbrain put <slug> --content """
            # {title}
            **作者：** {author} | **日期：** {date}

            ## 章节摘要
            {per_chapter_summary}

            ## 关键引用
            - p.{page}: "{quote}" -- {why_it_matters}

            ## 交叉引用
            {links_to_brain_pages_for_people_and_concepts}

            ---

            ## 来源
            {full_text_or_key_sections}
        """

        for entity in document.mentioned_entities:
            gbrain add_link <slug> <entity_slug>
            gbrain add_link <entity_slug> <slug>

    # 总是在摄取后同步
    gbrain sync
```

## 棘手的地方

1. **始终完整转录，永远不要 AI 摘要。** YouTube 的自动摘要和 AI 生成的摘要会丢失纹理：谁说了什么、确切的措辞、语气、什么没有说。完整的日记化转录是证据库。Agent 的分析在它上面。

2. **Agent 自己的分析是有价值的，不是 regurgitation。** "视频讨论了 AI 安全" 是没有价值的。"Dario 对计算扩展提出了具体主张，这与 Ilya 在 NeurIPS 演讲中说的话相矛盾 — 参见 media/youtube/ilya-neurips-2025" 是有用的。分析将新媒体与现有的 brain 连接起来。

3. **社交媒体是一个捆绑，不是一条单独的推文。** 没有其线程、引用的推文、链接的文章和参与上下文的推文是一个片段。在创建 brain 页面之前重建完整的上下文。

4. **交叉引用使媒体页面活跃。** 没有反向链接到提到的人员和公司的 YouTube 页面是一个死存档。每个提到的实体都获得一个链接和一个时间线条目。

5. **随着时间的推移，`media/` 变成一个可搜索的存档。** 用户消费的每个视频、播客、谈话、采访、文章和推文，顶部都有 agent 的评论层。这是全功率的 memex。

## 如何验证

1. 摄取一个 YouTube 视频。运行 `gbrain get media/youtube/{slug}`。确认页面有：agent 的分析（不仅仅是摘要）、带有说话者归属的关键引用，以及完整的日记化转录。
2. 运行 `gbrain get_links media/youtube/{slug}`。确认存在到视频中提到的每个人员和公司的 brain 页面的反向链接。
3. 选择视频中提到的一个人。运行 `gbrain get <person_slug>`。确认他们的时间线有一个引用带有特定上下文的视频的新条目。
4. 摄取一条推文。确认 brain 页面包括线程上下文、链接的文章摘要和实体交叉引用 — 而不仅仅是推文文本。
5. 运行 `gbrain search "{topic_from_video}"`。确认媒体页面出现在搜索结果中（验证内容已被索引和可搜索）。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
