# Schema 包

Schema 包告诉 gbrain 你的大脑采用什么形状 — 存在哪些目录，
其中存在哪些类型，代理应如何从路径推断类型，
以及哪些链接动词将什么连接到什么。Schema 包是
每个技能在归档、查询或路由专家时读取的
**动态、始终参考的工件**。它是
"你的大脑中有什么"的单一真相源。

v0.39.0.0 波次发布了一个完整的 schema-pack 大教堂。本文档是
面向用户的参考；有关实现详细信息，请参阅
`docs/designs/V038_SCHEMA_PACKS.md`（CEO 计划）和
`src/core/schema-pack/` 中的引擎层。

## 开箱即用的内容

两个捆绑包：

- **`gbrain-base`**（默认）— 逐字节重现 v0.38 之前的硬编码行为。
  现有大脑在升级后看到零行为更改。
  涵盖：person、company、deal、meeting、project、place、concept、writing、
  analysis、guide、hardware、architecture 等（原始
  `ALL_PAGE_TYPES` 列表）。

- **`gbrain-recommended`** — 通过 `docs/GBRAIN_RECOMMENDED_SCHEMA.md` 中描述的 13 个附加
  目录扩展 `gbrain-base`：deal、
  meeting、concept、project、source、daily、personal、civic、original、
  place、trip、conversation、writing。如果你喜欢文档化的
  操作大脑模式，请使用以下命令激活此选项：

  ```bash
  gbrain schema use gbrain-recommended
  ```

加上你使用 `gbrain schema init` 或 `gbrain schema fork` 创作的
位于 `~/.gbrain/schema-packs/<name>/pack.yaml` 的用户安装包。

## CLI 表面

五个检查动词（在 v0.38 中发布）：

```bash
gbrain schema active     # 显示已解析的包 + 设置它的层
gbrain schema list       # 列出捆绑 + 已安装的包
gbrain schema show       # 漂亮地打印活动包
gbrain schema validate   # 验证清单的形状
gbrain schema use <pack> # 激活一个包（写入 ~/.gbrain/config.json）
```

八个创作 + 发现动词（在 v0.39 中发布）：

```bash
gbrain schema detect              # 提出与大脑形状匹配的类型
gbrain schema suggest             # 在 detect 之上的 LLM 优化建议
gbrain schema review-candidates   # 提升 / 重命名 / 忽略候选者
gbrain schema review-orphans      # 显示没有匹配类型的页面
gbrain schema init <name>         # 搭建存根包    (实验性)
gbrain schema fork <a> <b>        # 复制 + 重命名一个包    (实验性)
gbrain schema edit <name>         # 显示包路径   (实验性)
gbrain schema diff <a> <b>        # 设置差异两个包      (实验性)
gbrain schema graph               # ASCII 类型列表      (实验性)
gbrain schema lint                # 标记重复项 + 缺失前缀
gbrain schema explain <type>      # 纯英语类型描述 (实验性)
gbrain schema downgrade --to <p>  # 恢复以前的包 (恢复)
gbrain schema usage --since 30d   # 每动词调用计数 (D14 遥测)
```

标记为 `实验性` 的动词根据 D14 按需求 gateway：它们的使用情况
通过 T15 的 schema-events 审计进行跟踪，并且 v0.40+ 决定是
否弃用任何保持 <5% 使用率的动词。

## 解析链（7 层）

当引擎决定"哪个包对此查询处于活动状态？"时，它会
自上而下遍历此链。第一个匹配获胜。

| 层 | 来源 | 说明 |
|------|--------|-------|
| 1 | 每调用 `schema_pack` 选项 | 仅限 CLI（`ctx.remote === false`）；MCP 拒绝。 |
| 2 | `GBRAIN_SCHEMA_PACK` 环境变量 | 进程范围覆盖。 |
| 3 | 每来源数据库配置键 `schema_pack:source:<id>` | v0.38 中的新增功能。 |
| 4 | 大脑范围的数据库配置键 `schema_pack` |  |
| 5 | `gbrain.yml` schema: 部分 | 仓库检查。 |
| 6 | `~/.gbrain/config.json` `schema_pack` 字段 | `gbrain schema use` 写入的内容。 |
| 7 | 默认：`gbrain-base` | 始终存在。 |

## 代理如何使用活动包

每个读取 + 写入路径在运行时查阅活动包：

- **`parseMarkdown`** 从活动中声明的路径前缀推断页面 `type`
  包（`page_types[].path_prefixes`）。没有活动的包
  线程，回退到旧的硬编码 `inferType()`，以便
  逐字节奇偶校验门保持绿色。
- **`whoknows` / `find_experts`** 将候选者范围限定为活动中 `expert_routing:
  true` 的类型。
- **`extract_facts`** 仅对 `extractable: true` 类型运行。
- **`enrichment-service`** 根据
  包的基元声明路由 person/company 丰富。
- **搜索混合缓存**（`knobsHash`）折叠包名称 + 版本
  （v0.39 T21）。在包 A 下写入的缓存行在包
  B 处于活动状态时无法访问。跨包污染在结构上是不可可能的。

## 神奇时刻 (T2-T4 + T10)

用户 A（Notion 难民）安装 gbrain，导入她的导出，并且
大脑看起来很陌生 — 默认的 `gbrain-base` 包需要
`people/`、`companies/` 等，但她的文件位于 `Projects/`、
`Reading/`、`Daily Notes/` 下。摩擦信号在两个地方触发：

1. **导入警告 (T7)：** `gbrain import` 的末尾会打印
   `[schema] Y 个页面中的 X 个（Z%）与活动 schema
   包没有匹配的类型。
   运行 gbrain schema detect 以提出与你的
   内容形状匹配的包。`
2. **`gbrain doctor` schema_pack_consistency 检查** 在导入会话结束后继续持续
   显示警告。

她运行神奇时刻：

```bash
gbrain schema detect              # 对她的实际形状进行启发式聚类
gbrain schema suggest             # LLM 优化的建议
gbrain schema review-candidates   # 人工门控升级
gbrain schema review-candidates --apply Projects/   # 接受
```

代理（通过新的 EIIRP 技能）为任何
重大工作会话自动执行此操作的第 1-3 阶段。大脑的模式成为代理维护的活工件，
而不是用户创作的硬编码仪式。

## 创作你自己的包

```bash
gbrain schema init my-pack            # 搭建 ~/.gbrain/schema-packs/my-pack/pack.yaml
$EDITOR ~/.gbrain/schema-packs/my-pack/pack.yaml
gbrain schema validate my-pack        # 检查形状
gbrain schema use my-pack             # 激活
gbrain schema active                  # 确认
```

最小的包：

```yaml
api_version: gbrain-schema-pack-v1
name: my-pack
version: 0.0.1
gbrain_min_version: 0.39.0
extends: gbrain-base   # 从基础继承所有内容；在下面添加覆盖
description: |
  我的个人包。

page_types:
  - name: project-x
    primitive: entity
    path_prefixes:
      - Projects/
    aliases: []
    extractable: false
    expert_routing: false

  # 在此处添加更多类型。每个都将路径前缀映射到基元 +
  # 选择加入标志。有关工作示例，请参阅 src/core/schema-pack/base/gbrain-recommended.yaml。

link_types: []
takes_kinds: [fact, take, bet, hunch]
borrow_from: []
frontmatter_links: []
enrichable_types: []
filing_rules: []
```

## 恢复 + 还原

单 PR 大教堂很难以原子方式还原。根据计划工程审查发现
#4，`T20 发布`gbrain schema downgrade` 以恢复
活动包配置字段：

```bash
gbrain schema downgrade --to gbrain-base
# 或自动从 ~/.gbrain/schema-pack-history.jsonl 检测以前的情况：
gbrain schema downgrade
```

**仅代码还原是不够的。** 完整还原过程：

1. `git revert <merge-commit>` — 恢复代码。
2. `gbrain schema downgrade --to gbrain-base` — 恢复配置。
3. （可选）`gbrain pages purge-deleted --older-than 0h` — 删除
   在活动包中不再具有匹配类型的
   v0.39 类型页面。

感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知感知。

缓存 + 评估行（感知感知感知感知感知感知感知写入）由
`knobsHash` 包折叠 (T21) 隔离 — 它们在
恢复的包下变得无法访问，因此不需要驱逐。

## 分发

`.gbrain-schema` tarball 与
`.gbrain-skillpack` tarball 使用相同的 v0.37 skillpack 管道 (T14 工件抽象)。
区分符是清单中的 `api_version`：

- `gbrain-schema-pack-v1` → schemapack
- `gbrain-skillpack-v1` → skillpack

两者都通过相同的搭建 + 复制路径安装；安装目标是
`~/.gbrain/schema-packs/<name>/` 和 `~/.gbrain/skillpacks/<name>/`
分别。

发布到公共注册表（`garrytan/gbrain-schema-registry`、
`garrytan/gbrain-skillpack-registry`）遵循与 v0.37 skillpack 发布相同的 publish-as-PR
工作流程。

## 推迟到 v0.40+ 的内容

- **跨挂载的每来源包联邦。** 跨多个
  来源的查询当前在这些来源
  具有不同的活动包时以 `permission_denied` 拒绝 (T19 + codex 发现 #2)。v0.40+ 工作
  通过现有的
  `buildSourceClosureCte` 引擎表面计算真正的每来源闭包。
- **包版本之间的 `extends` 链 semver 兼容性检查**。
- **`skillpack ↔ schemapack` 交叉引用声明** — skillpack
  可以声明"当你的包中存在这些基元时，我工作得最好。"
- **实时 schema 迁移帮助程序** — 当你添加类型时，自动建议
  回填现有页面。
- **创作与推导论文重构 (D14)。** v0.39.0.0 发布了
  完整的 11 个动词大教堂，其中 6 个动词标记为实验层。v0.40+
  回归读取 T23 使用遥测以决定要弃用哪个。

有关完整的推迟列表，请参阅 `TODOS.md` v0.40+ 部分。
