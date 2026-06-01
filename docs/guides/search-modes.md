# 搜索模式

## 目标

知道使用哪个搜索命令以及何时使用 — 关键字、混合或直接 — 以便每次查找都快速并返回正确的结果。

## 用户获得什么

如果没有这个：代理在搜索命令之间笨拙地摸索，当需要完整页面时返回块，在直接 get 就可以的情况下运行昂贵的语义搜索，或者完全错过结果。有了这个：每次查找都使用最优模式，令牌预算得到尊重，用户在最少的调用中获得正确的信息。

## 实施

```
on user_asks_about(topic):
    # 决策树：选择合适的搜索模式

    if know_exact_slug(topic):
        # 模式3：直接获取 — 即时，无搜索开销
        result = gbrain get <slug>
        # 例如，"告诉我关于 Pedro 的事" -> gbrain get pedro-franceschi
        # 返回完整页面 — 编译的真相 + 时间线

    elif topic.is_exact_name or topic.is_keyword:
        # 模式1：关键字搜索 — 快速，不需要嵌入，第一天就可用
        results = gbrain search "{name_or_keyword}"
        # 例如，"找到关于 A 轮的任何内容" -> gbrain search "Series A"
        # 返回块，而不是完整页面

        # 重要：关键字搜索返回块
        # 如果块确认相关性，然后加载完整页面：
        if chunk.confirms_relevance:
            full_page = gbrain get <slug_from_chunk>

    elif topic.is_semantic_question:
        # 模式2：混合搜索 — 语义 + 关键字，需要嵌入
        results = gbrain query "{natural language question}"
        # 例如，"我在金融科技公司认识谁？" -> gbrain query "fintech contacts"
        # 通过向量 + 关键字 + RRF 返回排名的块

        # 同样规则：先块，然后如果需要获取完整页面
        if chunk.confirms_relevance:
            full_page = gbrain get <slug_from_chunk>

# 快速参考：
# | 模式    | 命令              | 需要嵌入 | 速度   | 最适合                        |
# |---------|----------------------|------------------|---------|---------------------------------|
# | 关键字 | gbrain search "term" | 否               | 最快 | 已知名称，精确匹配      |
# | 混合  | gbrain query "..."   | 是              | 快    | 语义问题，模糊匹配  |
# | 直接  | gbrain get <slug>    | 否               | 即时 | 当你知道 slug          |

# 随时间推移的进展：
#   第1天：关键字搜索（无需嵌入即可工作）
#   第一次嵌入后：解锁混合搜索
#   一旦你知道 slug：直接获取以提高速度

# 页面内冲突信息的优先级：
#   1. 用户的直接陈述（总是赢）
#   2. 编译的真相部分（从证据综合而来）
#   3. 时间线条目（原始信号，反向时间顺序）
#   4. 外部来源（网络搜索，API）
```

## 棘手的地方

1. **搜索返回块，而不是完整页面。** 在 `gbrain search` 或 `gbrain query` 之后，你得到摘录。在块确认相关性后，始终运行 `gbrain get <slug>` 以加载完整页面。当完整的上下文很重要时，不要仅从块回答问题。
2. **关键字搜索无需嵌入即可工作。** 在第一次嵌入运行之前的第 1 天，`gbrain search` 仍然工作。不要告诉用户"搜索尚不可用" — 关键字搜索始终可用。
3. **不要对已知名称使用混合搜索。** `gbrain query "Pedro Franceschi"` 浪费嵌入计算。使用 `gbrain search "Pedro Franceschi"` 或者如果你知道 slug 的话更好 `gbrain get pedro-franceschi`。
4. **令牌预算意识。** 通过 `gbrain get` 获取完整页面可能很大。在拉取完整页面之前先读取搜索块以确认相关性。"有人提到 A 轮吗？" — 搜索结果（块）可能就足够了。"告诉我关于 Pedro 的一切" — 获取完整页面。
5. **混合搜索需要已经运行嵌入。** 如果 `gbrain query` 返回空但 `gbrain search` 找到结果，则嵌入尚未生成。首先运行嵌入管道。

## 如何验证

1. 运行 `gbrain search "Pedro"` — 确认它返回带有匹配文本和 slug 引用的块。
2. 运行 `gbrain query "who works at fintech companies"` — 确认它返回语义相关的结果（不仅仅是 "fintech" 的关键字匹配）。
3. 运行 `gbrain get pedro-franceschi` — 确认它返回带有编译的真相和时间线的完整页面。
4. 比较：使用所有三种模式搜索同一实体。关键字应该最快，混合应该浮出概念匹配，直接应该返回完整页面。
5. 搜索返回块后，对来自该块的 slug 运行 `gbrain get`。确认完整页面包含的上下文比块单独包含的更多。

---
*属于 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
