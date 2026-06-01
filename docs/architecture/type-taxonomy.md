# 类型分类法 (v0.41.22: gbrain-base-v2)

> 在 v0.41.22 中发布的 14 规范类型 DRY/MECE 分类法。前身
> `gbrain-base`（24 个类型）保持捆绑以获得向后兼容性；v0.42+ 安装
> 默认为 `gbrain-base-v2`。

## 为何

生产 gbrain 大脑（186K 页面）已经积累了 **94 个不同的
`pages.type` 值**，分布在 9 个冗余集群中。类型系统是
schema 包、搜索过滤、提取行为、
丰富路由和专家路由的基础。当类型有噪声时，每个
下游功能都会降级：

- **搜索过滤是模糊的** — `--type article` 错过 2.2K
  类型为 `media/article`、`sources/article` 等的
  文章。
- **丰富路由是不完整的** — `enrichable_types` 只能
  列出几个规范类型；80%+ 旧类型意味着大多数页面永远不会
  被丰富。
- **代理混淆** — 当摄取新文章时，它应该是
  `article`、`media/article`、`sources/article` 还是 `source/article`？
  四个合理的选择，没有一个是正确。
- **孤儿膨胀** — 5,521 个概念重定向页面使孤儿
  计数膨胀而没有增加知识价值。

问题 #1479 以精确计数记录 9 个集群。本文档是
响应：一个连贯的 14 类型分类法，其子类型/格式/来源
被推送到 frontmatter、重定向的别名表行、边的形状页面的真实链接表。

## 14 个规范类型（+ `note` 包罗万象）

| 类型 | 基元 | 它包含什么 | 示例 |
|------|-----------|---------------|----------|
| `person` | entity | 人员 | 创始人、合作伙伴、个人 |
| `company` | entity | 公司、产品、组织（子类型区分） | 公司、YC 公司、产品 |
| `media` | media | 文章、视频、论文、书籍、播客（子类型区分） | Substack 帖子、YouTube 视频、书籍 |
| `tweet` | media | Twitter 帖子（single/bundle/stub 子类型） | 单条推文、主题、捆绑包 |
| `social-digest` | temporal | 按周期分组的社交摘要（每日/每月） | X 帐户每日摘要 |
| `analysis` | media | 研究 + 竞争情报 | 市场分析、定价分析 |
| `atom` | annotation | 知识单元（提取/手动/传说子类型） | 提取的事实、手动笔记、传说 |
| `concept` | concept | 想法 + 参考页面 | Wiki 概念 |
| `source` | media | 脚本、参考 | 采访脚本 |
| `deal` | temporal | 投资交易 | 条款清单、投资 |
| `email` | temporal | 电子邮件主题 | 电子邮件通信 |
| `slack` | temporal | Slack 消息 + 主题 | Slack 对话 |
| `writing` | media | 原创写作 | 草稿、进行中的论文 |
| `project` | concept | 倡议、工作流 | 内部项目 |
| `note` | concept | **包罗万象** 用于一次性（保留 legacy_type） | 备忘录、轶事、见解等 |

总共 15 个类型（14 个规范 + `note`）。包罗万象的重类型规则
将任何未覆盖的旧类型绑定到 `note`，其中
`frontmatter.legacy_type = <original>` 被保留用于回滚。

## 子类型（在统一后声明在 frontmatter 中）

| 规范 | 子类型字段 | 值 |
|-----------|---------------|--------|
| `company` | `subtype` | `company` / `product` / `org` |
| `media` | `subtype` | `video` / `article` / `essay` / `book` / `podcast` / `blog` |
| `tweet` | `subtype` | `single` / `bundle` / `stub` |
| `social-digest` | `subtype` | `daily` / `monthly` |
| `atom` | `subtype` | `extraction` / `manual` / `lore` |

重类型规则的 `subtype_field` 仅限于允许列表：
`{subtype, legacy_type, origin, format, kind, period, domain}`。这
防止第三方包通过 mapping_rules 注入 `title`、`slug` 或 `type`
（codex D9 安全加固）。

## 迁移流程

```
gbrain onboard --check                         # 显露 pack_upgrade_available
        ↓
gbrain onboard --check --explain               # 每集群叙述 dry-run
        ↓
gbrain jobs submit unify-types \               # PROTECTED + manual_only
  --allow-protected \
  --params '{"target_pack":"gbrain-base-v2"}'
        ↓
处理程序运行 4 个阶段：
 ┌─────────────────────────────────────┐
 │ 阶段 1：预检 + 锁           │ → gbrain-unify db-锁 (60 分钟 TTL)
 ├─────────────────────────────────────┤
 │ 阶段 2：重类型显式规则      │ → 分块 UPDATE 1000/批
 ├─────────────────────────────────────┤
 │ 阶段 3：重类型包罗万象哨兵  │ → 带有 legacy_type 的 'note'
 ├─────────────────────────────────────┤
 │ 阶段 4：页面到链接转换   │ → 插入链接 + soft-delete
 ├─────────────────────────────────────┤
 │ 阶段 5：页面到别名转换  │ → 插入 slug_aliases + soft-delete
 ├─────────────────────────────────────┤
 │ 阶段 6：最终同步（残留）      │ → path-prefix 类型
 ├─────────────────────────────────────┤
 │ 阶段 7：翻转活动包 (D13)     │ → engine.setConfig + saveConfig
 ├─────────────────────────────────────┤
 │ 阶段 8：验证 + 庆祝         │ → 断言 ≤16 个类型；stderr 摘要
 └─────────────────────────────────────┘
        ↓
gbrain onboard --check                         # pack_upgrade_available 已清除
                                               # type_proliferation 已清除
```

## 回滚路径

每个基元都附带有文档化的回滚：

| 操作 | 回滚 |
|-----------|----------|
| 重类型 | `frontmatter.legacy_type = <original>` 保留在每个页面上 (D8)。一个 SQL UPDATE 恢复类型：`UPDATE pages SET type = frontmatter->>'legacy_type' WHERE frontmatter ? 'legacy_type'`。 |
| 页面到链接 | 源页面 soft-deleted，带有 72 小时 TTL。在 72 小时内 `gbrain pages restore <slug>`。如果源已还原，则链接行保持无害。 |
| 页面到别名 | 源页面 soft-deleted，带有 72 小时 TTL。在 72 小时内 `gbrain pages restore <slug>`。别名行保持无害（或 `DELETE FROM slug_aliases WHERE alias_slug = <slug>` 以清理）。 |
| 活动包翻转 | `gbrain schema use gbrain-base` 反转翻转。 |

## 如果我的大脑不适合怎么办？

包罗万象的重类型规则 (`from_type: '*unknown*'`) 会自动处理长尾
类型 — 任何类型未被显式
规则覆盖并且不是 page_to_link / page_to_alias 源的类型都会重类型到
`note`，并保留 `legacy_type`。保证在任何大脑上统一后 ≤16 个不同的类型。

对于具有值得其自己规范的实质性自定义类型的大脑
（例如，用于学术大脑的 `researcher`），正确的做法是：

1. Fork gbrain-base-v2：`gbrain schema fork gbrain-base-v2 my-pack`
2. 编辑你的 fork 以添加覆盖你的
   自定义域的 page_types + mapping_rules。
3. 目标你的 fork：`gbrain jobs submit unify-types --allow-protected
   --params '{"target_pack":"my-pack"}'`

你的 fork 也可以声明 `migration_from: {pack: gbrain-base-v2,
version: "1.x"}` 以将自己注册为继承者 — 未来代理
通过 `pack_upgrade_available` 发现你的包将提供
迁移。

## 统一后的 Wikilink 解析

slug_aliases 表是解析器 (D15：codex 外部语音 —
不要重写正文文本 wikilinks；别名表是正确的
基元)。像 `[[old-redirect-slug]]` 这样的 Wikilinks 在统一后继续
工作，因为：

1. Wikilink 解析器在现有
   模糊/前缀级联之前通过
   `engine.resolveSlugWithAlias(slug, sourceId)` 短路。
2. 查找查询 `slug_aliases` 以查找所提供的来源中的任何匹配 alias_slug
   (s)。
3. 如果找到，则返回 canonical_slug。然后渲染器将
   wikilink 解析为规范页面。

多来源歧义（两个已注册来源中的相同 alias_slug）
发出一次每进程 `multi_match` stderr 警告，并按来源数组顺序返回
第一个匹配项。联邦读取传递完整的
允许的来源数组。

## 搜索排名信号：alias_resolved_boost

统一后，搜索结果（其在
slug_aliases 中是 canonical_slug）通过
`applyAliasResolvedBoost` 后融合阶段获得 1.05 倍分数乘数。语义意图："用户
显式消歧此内容作为规范，因此它应该排名为模糊
匹配，这些匹配意外地命中了别名。"

`SearchResult.alias_resolved_boost` 在触摸结果上标记，用于
`--explain` 格式化程序可见性。KNOBS_HASH_VERSION 从 5 提升到 6 以
使不反映新阶段的前 v0.42 缓存行无效。

## 参考

- 问题：https://github.com/garrytan/gbrain/issues/1479
- 包文件：`src/core/schema-pack/base/gbrain-base-v2.yaml`
- 包升级机制：`docs/architecture/pack-upgrade-mechanism.md`
- 迁移处理程序：`src/core/schema-pack/unify-types-handler.ts`
- 登机检查：`src/core/onboard/checks.ts`
- 渲染允许列表：`src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS`
- 处理程序：`src/core/schema-pack/unify-types-handler.ts`
- 迁移：`src/core/migrate.ts:105`（slug_aliases 表）
- 类型分类法文档：`docs/architecture/type-taxonomy.md`
- 技能：`skills/schema-unify/SKILL.md`
