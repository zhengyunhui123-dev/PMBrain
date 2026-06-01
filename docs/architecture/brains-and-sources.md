# 大脑与来源 — 心智模型

GBrain 有两个正交轴用于组织知识。用户和代理都需要
理解它们，否则查询会静默地路由错误。

**太长不看：**
- **大脑（brain）** 是一个数据库。你可以拥有多个。
- **来源（source）** 是大脑内部的内容命名仓库。一个大脑可以容纳多个。
- `--brain <id>` 选择使用哪个数据库。
- `--source <id>` 选择该数据库内的哪个仓库。
- 它们相互独立。你可以定位到任意组合。

---

## 两个轴

### 大脑（数据库轴）

**大脑** 是一个数据库 — PGLite 文件、自托管 Postgres 或 Supabase。
每个大脑拥有：
- 自己的 `pages` 表、`chunks` 表、`embeddings` 等。
- 如果通过 HTTP MCP 提供服务（v0.19+，PR 2），拥有自己的 OAuth 表面。
- 自己的独立生命周期、备份、访问控制。

大脑通过以下方式枚举：

- **宿主（host）** — 你的默认大脑，配置在 `~/.gbrain/config.json` 中。
- **挂载（mounts）** — 通过 `gbrain mounts add <id>`（v0.19+）在 `~/.gbrain/mounts.json` 中注册的附加大脑。

路由：`--brain <id>`、`GBRAIN_BRAIN_ID`、`.gbrain-mount` 点文件，或
针对已注册挂载路径的最长路径匹配。回退到 `host`。

### 来源（仓库轴，v0.18.0+）

**来源** 是大脑内部的一个命名内容仓库。每一行 `pages`
都携带一个 `source_id`。别名在每个来源内是唯一的，而不是全局唯一的。

示例：在一个大脑中，别名 `topics/ai` 可以存在于 `source=wiki`
和 `source=gstack` 下 — 它们是不同的页面。

路由：`--source <id>`、`GBRAIN_SOURCE`、`.gbrain-source` 点文件，或
`sources` 表中已注册的 `local_path` 匹配。

### 何时使用哪个轴？

| 你想要 | 调整 |
|---|---|
| 在同一大脑内的不同仓库中工作（wiki → gstack 笔记） | `--source` |
| 查询他人发布的团队大脑 | `--brain` |
| 隔离一个主题，使其永远不会泄漏到个人搜索中 | 使用 `federated=false` 的 `--source` |
| 与队友共享大脑 | `--brain`（挂载团队大脑） |
| 向你的个人大脑添加新仓库 | 通过 `gbrain sources add` 使用 `--source` |
| 添加团队大脑 | 通过 `gbrain mounts add` 使用 `--brain` |

**经验法则：** 如果数据所有者发生变化，那就是大脑边界。如果
数据所有者保持不变但主题/仓库发生变化，那就是来源边界。

---

## 拓扑：单人开发者

最简单的情况。一个大脑，一个来源。

```
┌─────────────────────────────────────────┐
│  host brain (~/.gbrain)                 │
│  ├── source: default (federated=true)   │
│  │   └── all pages                      │
└─────────────────────────────────────────┘
```

`gbrain query "retry budgets"` 会找到所有内容。不需要 `--brain` 或 `--source`。

---

## 拓扑：具有多个仓库的个人大脑

你维护多个代码库或写作流。每个都是同一个大脑内的自己的来源。
跨来源搜索默认开启，因此关于"缓存"的查询会返回来自每个仓库的命中结果。

```
┌──────────────────────────────────────────────┐
│  host brain (~/.gbrain)                      │
│  ├── source: wiki      (federated=true)      │
│  │   └── personal notes, people, companies   │
│  ├── source: gstack    (federated=true)      │
│  │   └── gstack plans, learnings             │
│  ├── source: openclaw  (federated=true)      │
│  │   └── openclaw docs, memos                │
│  └── source: essays    (federated=false)     │
│      └── draft essays, isolated on purpose   │
└──────────────────────────────────────────────┘
```

在 `~/openclaw/` 内，`.gbrain-source` 点文件将每个命令固定到
`source=openclaw`。在 `~/gstack/` 内，点文件固定到 `source=gstack`。
所有内容仍然定位到同一个数据库。

在以下情况下使用此拓扑：

- 你拥有所有内容。
- 你希望跨仓库搜索能够正常工作。
- 你不需要与不是你的任何人共享其中的任何内容。

---

## 拓扑：个人大脑 + 一个团队大脑

你在一个发布共享大脑的团队中。你的个人大脑保持
原样；你将它旁边的团队大脑挂载起来。

```
┌──────────────────────────────────────────────┐
│  host brain (~/.gbrain)  — YOUR personal DB  │
│  ├── source: wiki                            │
│  ├── source: gstack                          │
│  └── ...                                     │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: media-team                           │
│  path:   ~/team-brains/media                 │
│  engine: postgres (team's Supabase)          │
│  └── sources: wiki, raw, enriched            │
└──────────────────────────────────────────────┘
```

`gbrain query "X"`（无标志）→ 针对宿主运行（你的个人大脑）。
`gbrain query "X" --brain media-team` → 针对团队的数据库运行。
在 `~/team-brains/media/` 内，`.gbrain-mount` 点文件自动将大脑固定到
`media-team`。

在以下情况下使用此拓扑：

- 你在一个团队中，并且有人发布团队订阅的大脑。
- 你需要在工作和个人之间隔离数据。
- 不同的团队/组织拥有不同的大脑。

---

## 拓扑：具有多个团队成员身份的 CEO 级用户

你足够资深，可以横跨多个团队。你维护你的个人
大脑（内部有 N 个来源）并且挂载多个工作团队大脑。每个团队
大脑本身在 v0.18.0 意义上是多来源大脑 — 无论团队所有者选择何种方式在内部进行组织。

```
┌──────────────────────────────────────────────┐
│  host brain — YOUR personal DB               │
│  ├── source: wiki                            │
│  ├── source: essays                          │
│  ├── source: gstack                          │
│  └── source: openclaw                        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: media-team (your media team's brain) │
│  └── sources: wiki, pipeline, enriched       │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: policy-team (your policy team's)     │
│  └── sources: wiki, research, letters        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: portfolio (another team's)           │
│  └── sources: companies, deals, diligence    │
└──────────────────────────────────────────────┘
```

在每个团队的检出（checkout）中，`.gbrain-mount` 点文件固定大脑。在
特定子目录中，`.gbrain-source` 点文件固定来源。因此 `cd
~/team-brains/policy/research && gbrain query "X"` 定位到
`brain=policy-team, source=research`，无需任何标志。

在以下情况下使用此拓扑：

- 你横跨多个团队。
- 每个团队拥有自己的大脑及其自己的访问策略。
- 你需要潜在空间联邦（代理决定何时跨大脑查询），
  而不是 SQL 联邦。

跨大脑查询在 v0.19 中**不是确定性的**。代理会看到
大脑列表并根据需要重新查询。这就是功能所在 — 它保持调试
健全且访问控制清晰。

---

## 解析优先级（一页纸供记忆）

```
哪个大脑（数据库）？                    哪个来源（数据库中的仓库）？
 1. --brain <id>                      1. --source <id>
 2. GBRAIN_BRAIN_ID 环境变量               2. GBRAIN_SOURCE 环境变量
 3. .gbrain-mount 点文件             3. .gbrain-source 点文件
 4. 最长前缀挂载路径匹配   4. 最长前缀来源路径匹配
 5. （保留：brains.default v2）     5. sources.default 配置
 6. 回退：'host'                  6. 回退：'default'
```

两个轴故意遵循相同的分层模式。如果你知道一个，你就
知道另一个。

---

## 给阅读此文的代理

- 当用户提出问题时，默认假设：从当前
  大脑开始（通过上面的优先级解析）。没有
  理由不要跳跃大脑。
- 如果用户提出的问题横跨某个团队可能拥有的主题
  （例如"X 团队上周决定了什么？"），正确的做法是以显式方式*查询
  该团队的大脑*，而不是使用"team x"进行宿主搜索。
- 跨大脑联邦是你的工作，而不是数据库的工作。你拥有大脑列表
 （`gbrain mounts list`）。你决定何时进行扇出。你综合
  发现结果。你引用 `brain:source:slug`。
- 写入页面时，尊重大脑边界。关于团队
  工作的一个事实属于团队的大脑，而不是用户的个人大脑。在
  写入跨大脑之前询问。
- 有关完整的决策表，请参阅 `skills/conventions/brain-routing.md`。

## 给阅读此文的用户

- **默认路径：** 设置你的个人大脑（`gbrain init`），为每个你关心的仓库添加一个来源
  （`gbrain sources add gstack --path ~/gstack`）。
  你几乎永远不需要 `--brain`。
- **当团队发布大脑时：** `gbrain mounts add <team-id> --path
  <clone> --db-url <url>` 并且该检出中的 `.gbrain-mount` 点文件会将
  查询自动路由到那里。
- **当你是具有多个团队成员身份的 CEO 级用户时：** 挂载
  每个团队的大脑。相信解析器 — 在团队目录内，
  点文件会选择大脑，在子目录内，点文件会选择
  来源。这些标志用于当你想要刻意查询边界时。

## 进一步阅读

- v0.18.0 CHANGELOG — 引入了 `sources` 原语。
- v0.19.0 CHANGELOG（PR 0+1+2 发布后待定）— 引入 `mounts`。
- `docs/mounts/publishing-a-team-brain.md`（PR 2）— 如何成为大脑
  发布者，而不仅仅是订阅者。
