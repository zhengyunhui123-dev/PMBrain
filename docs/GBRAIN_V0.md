# GBrain v0：原生 Postgres 个人知识 Brain

> **历史设计文档。** 这是来自 PGLite 落地之前的原始 v0 规范。几个
> 前瞻性部分 — 最值得注意的是 SQLite 引擎计划 — 被
> PGLite（通过 WASM 嵌入的 Postgres 17）取代，它使用与 Postgres 相同的 SQL 方言并
> 消除对单独的 FTS5/sqlite-vss 翻译层的需求。此处保留用于
> 历史上下文；有关当前引擎架构，请参见 [`ENGINES.md`](ENGINES.md) 以及
> 实际实现历史的 [`CHANGELOG.md`](../CHANGELOG.md)。

## 这是什么

GBrain 是一个编译智能系统。不是笔记应用。不是"与你的笔记聊天。"

每个页面都是情报评估。线上方：编译的真相（你当前的最佳理解，在新证据到达时重写）。线下方：时间线（仅追加证据轨迹）。AI 代理维护 brain。MCP 客户端查询它。智能存在于胖 markdown 技能中，而不是应用程序代码中。

核心见解：规模化的个人知识是一个智能问题，而不是存储问题。

## 为什么它存在

一个 7,471 文件 / 2.3GB markdown wiki 正在窒息 git。Git 在 ~5K 文件后无法扩展以用于 wiki 风格的使用。编译的真相 + 时间线模型（Karpathy 风格的知识页面）是正确的，但它需要在下面有一个真实的数据库。

已经有一个生产级 RAG 系统（Ruby on Rails、Postgres + pgvector），具有 3 层分块、带 RRF 的混合搜索、多查询扩展和 4 层去重。GBrain 将这些经过验证的模式移植到独立的 Bun + TypeScript 工具。

## 知识模型

```
+--------------------------------------------------+
|  Page: concepts/do-things-that-dont-scale         |
|                                                   |
|  --- frontmatter (YAML) ---                       |
|  type: concept                                    |
|  tags: [startups, growth, pg-essay]               |
|                                                   |
|  === COMPILED TRUTH ===                           |
|  Current best understanding.                      |
|  Rewritten on new evidence.                       |
|  This is the "what we know now" section.          |
|                                                   |
|  ---                                              |
|                                                   |
|  === TIMELINE ===                                 |
|  Append-only evidence trail.                      |
|  - 2013-07-01: Published on paulgraham.com        |
|  - 2024-11-15: Referenced in batch kickoff talk   |
|  Never edited, only appended.                     |
+--------------------------------------------------+
          |                    |
          v                    v
  [Semantic chunks]     [Recursive chunks]
  (best quality for     (predictable format
   compiled truth)       for timeline)
          |                    |
          v                    v
  [Embeddings: text-embedding-3-large, 1536 dims]
          |
          v
  [HNSW index + tsvector + pg_trgm]
          |
          v
  [Hybrid search: vector + keyword + RRF fusion]
```

## 架构决策

### v0 技术栈

| 层 | 选择 | 为什么 |
|-------|--------|-----|
| 数据库 | Postgres + pgvector | 经过验证的 RAG 模式，生产测试。世界级混合搜索。 |
| 托管 | Supabase Pro（$25/月） | 零运维。托管 Postgres，pgvector，连接池。8GB 存储。 |
| 运行时 | Bun + TypeScript | 与 GStack 生态系统一致。快速。编译为单个二进制文件。 |
| 嵌入 | OpenAI text-embedding-3-large | 1536 维（通过 dimensions API 从 3072 减少）。约 $0.13/1M 令牌。 |
| LLM（分块/扩展） | Claude Haiku | 用于主题边界检测和查询扩展的最便宜模型。 |
| 后台作业 | Trigger.dev | 无服务器。嵌入回填、陈旧检测、孤儿审计、标签一致性。 |
| 分发 | npm 包 + 编译二进制文件 + MCP 服务器 | 用于 OpenClaw 的库、用于人类的 CLI、用于代理的 MCP。 |

### 我们的选择以及为什么

**Postgres 优于 SQLite。** 我们有 3+ 年经过验证的 RAG 模式在 Postgres 上运行。用于全文搜索的 tsvector、用于语义搜索的 pgvector HNSW、用于模糊 slug 匹配的 pg_trgm。将这些移植到 SQLite 意味着从头重新实现搜索。SQLite 是未来用于轻量级开源用户的插件式引擎（参见 `docs/ENGINES.md`）。

**Supabase 优于自托管。** 零维护。Brain 应该是 AI 代理使用的基础设施，而不是你管理东西。免费层有 pgvector 但只有 500MB（对于具有嵌入的 7K+ 页面来说不够，需要约 750MB）。Pro 层 at $25/月 给出 8GB。v1 中没有 Docker、没有自托管 Postgres。

**完整移植优于最低可行。** 模式是经过验证的。移植是机械性的。从第一天开始提供世界级的 RAG，带有完整的 3 层分块 + 混合搜索 + 4 层去重。"我们稍后会添加那个"意味着稍后重建一切。

**库优先分发。** gbrain 是一个 npm 包。OpenClaw 将其作为依赖项安装（`bun add gbrain`），直接导入引擎。零开销函数调用、共享连接池、TypeScript 类型。CLI 和 MCP 服务器是同一引擎上的瘦包装器。

**基于触发器的 tsvector（不是生成的列）。** 要在全文搜索中包含 timeline_entries 内容，tsvector 需要跨越多个表。生成的列不能做跨表引用。页面 + timeline_entries 上的触发器更新 search_vector。

**导入期间自动嵌入。** 没有单独的嵌入步骤。`gbrain import` 在一次传递中分块和嵌入。进度条显示状态。`--no-embed` 标志用于想要延迟的用户。`embedded_at` 列启用 `gbrain embed --stale` 以进行回填。

## 分发模型

```
+-------------------+     +-------------------+     +-------------------+
|   npm package     |     |  Compiled binary  |     |   MCP server      |
|   (library)       |     |  (CLI)            |     |   (stdio)         |
+-------------------+     +-------------------+     +-------------------+
|                   |     |                   |     |                   |
| bun add gbrain    |     | GitHub Releases   |     | gbrain serve      |
| import { Postgres |     | npx gbrain        |     | in mcp.json       |
|   Engine }        |     |                   |     |                   |
|                   |     |                   |     |                   |
| WHO: OpenClaw,    |     | WHO: Humans       |     | WHO: Claude Code,  |
| AlphaClaw         |     |                   |     | Cursor, etc.      |
+-------------------+     +-------------------+     +-------------------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                            +--------v--------+
                            |  BrainEngine    |
                            |  (pluggable     |
                            |   interface)    |
                            +-----------------+
                                   |
                     +-------------+-------------+
                     |                           |
              +------v------+            +-------v-------+
              | Postgres    |            | SQLite        |
              | Engine      |            | Engine        |
              | (v0, ships) |            | (future, see  |
              +-------------+            | ENGINES.md)   |
                                         +---------------+
```

package.json 导出：
- 库：`src/core/index.ts`（BrainEngine 接口、PostgresEngine、类型）
- CLI 二进制文件：`src/cli.ts`

## 首次体验

### 路径 1：OpenClaw 用户（主要）

OpenClaw 是使用 gbrain 作为其知识后端的 AI 编排器。这是最常见的安装路径。

```bash
# 1. 将 gbrain 安装为 ClawHub 技能
clawhub install gbrain

# 2. 技能在首次使用时运行引导式设置：
#    - 检测 Supabase CLI 是否可用
#    - 如果是：自动配置新的 Supabase 项目
#    - 如果否：提示输入连接 URL
#    - 运行模式迁移
#    - 扫描 markdown 仓库并导入用户的内容
#    - 显示实时实体/边缘提取动画
#    - Brain 准备就绪

# 3. 从 OpenClaw，brain 工具现在可用：
#    "Search the brain for [topic from your data]"
#    "Ingest my meeting notes from today"
#    "How many pages are in the brain?"
```

在幕后，`clawhub install gbrain`：
1. 安装 `gbrain` npm 包
2. 提供 SKILL.md 文件（摄取、查询、维护、丰富、简报、迁移）
3. 向编排器注册 brain 工具
4. 在首次使用时运行 `gbrain init --supabase`（引导式向导）

### 路径 2：CLI 用户（独立）

```bash
# 1. 安装
npm install -g gbrain
# 或：从 GitHub Releases 下载二进制文件

# 2. 使用 Supabase 初始化
gbrain init --supabase
# 引导式向导：
#   Try 1: Supabase CLI 自动配置 (npx supabase)
#   Try 2: 如果 CLI 未安装或未登录，回退：
#          "Enter your Supabase connection URL:"
#   然后：运行模式迁移，验证 pgvector 扩展
#   然后：验证数据库已准备好导入
#   输出："Brain ready. Run: gbrain import <your-repo>"

# 3. 导入你的数据
gbrain import /path/to/markdown/wiki/
# 进度条：7,471 个文件，自动分块，自动嵌入
# ~30s 用于文本导入，~10-15 分钟用于嵌入

# 4. 查询
gbrain query "what does PG say about doing things that don't scale?"
```

### 路径 3：MCP 用户（Claude Code、Cursor）

```json
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

然后在 Claude Code 中："Search my brain for people who know about robotics"

### 详细信息中的初始化向导

`gbrain init --supabase` 通过这些步骤运行：

```
Step 1: Database Setup
  ├── Check for Supabase CLI (npx supabase --version)
  │   ├── Found + logged in → auto-create project
  │   │   ├── Create project via supabase CLI
  │   │   ├── Wait for project to be ready
  │   │   └── Extract connection string
  │   ├── Found + not logged in →
  │   │   └── Error: "Supabase CLI found but not logged in."
  │   │         Cause: "You need to authenticate first."
  │   │         Fix: "Run: npx supabase login"
  │   │         Docs: "https://supabase.com/docs/guides/cli"
  │   └── Not found → fallback to manual
  │       └── Prompt: "Enter your Supabase connection URL:"
  │
Step 2: Schema Migration
  ├── Connect to database
  ├── CREATE EXTENSION IF NOT EXISTS vector
  ├── CREATE EXTENSION IF NOT EXISTS pg_trgm
  ├── Run src/schema.sql (all tables, indexes, triggers)
  └── Verify: test insert + vector query

Step 3: Config
  ├── Write ~/.gbrain/config.json (0600 permissions)
  │   { "database_url": "...", "service_role_key": "..." }
  └── Verify connection

Step 4: Kindling Import
  ├── Import 10 bundled PG essays as demo data
  ├── Chunk + embed each essay
  ├── Show live entity/edge extraction animation:
  │   "Extracting entities... Paul Graham (person), Y Combinator (company)..."
  │   "Creating links... Paul Graham → Y Combinator (founded)..."
  └── Output: "Brain ready. 10 pages imported."

Step 5: First Query
  └── "Try: gbrain query 'what does PG say about doing things that don't scale?'"
```

每个错误都遵循样式指南：问题 + 原因 + 修复 + 文档链接。

## CLI 命令

```
gbrain init [--supabase|--url <conn>]     # create brain
gbrain get <slug>                          # read a page
gbrain put <slug> [< file.md]             # write/update a page
gbrain search <query>                      # keyword search (tsvector)
gbrain query <question>                    # hybrid search (RRF + expansion)
gbrain ingest <file> [--type ...]         # ingest a source document
gbrain link <from> <to> [--type <type>]   # create typed link
gbrain unlink <from> <to>                 # remove link
gbrain graph <slug> [--depth 5]           # traverse link graph (recursive CTE)
gbrain backlinks <slug>                    # incoming links
gbrain tags <slug>                         # list tags
gbrain tag <slug> <tag>                    # add tag
gbrain untag <slug> <tag>                  # remove tag
gbrain timeline [<slug>]                   # view timeline
gbrain timeline-add <slug> <date> <text>  # add timeline entry
gbrain list [--type] [--tag] [--limit]    # list with filters
gbrain stats                               # brain statistics
gbrain health                              # brain health dashboard
gbrain import <dir> [--no-embed]          # import from markdown directory
gbrain export [--dir ./export/]           # export to markdown (round-trip)
gbrain embed [<slug>|--all|--stale]       # generate/refresh embeddings
gbrain serve                               # MCP server (stdio)
gbrain call <tool> '<json>'               # raw tool invocation
gbrain upgrade                             # self-update (npm, binary, ClawHub)
gbrain version                             # version info
gbrain config [get|set] <key> [value]     # brain config
```

CLI 和 MCP 公开相同的操作。Drift 测试断言跨两个接口的所有操作的相同结果。

## 数据库模式

Postgres + pgvector 中的 9 个表：

```
+------------------+     +-------------------+     +------------------+
|     pages        |---->|  content_chunks   |     |     links        |
|------------------|     |-------------------|     |------------------|
| id (PK)          |     | id (PK)           |     | id (PK)          |
| slug (UNIQUE)    |     | page_id (FK)      |     | from_page_id(FK) |
| type             |     | chunk_index       |     | to_page_id (FK)  |
| title            |     | chunk_text        |     | link_type        |
| compiled_truth   |     | chunk_source      |     | context          |
| timeline         |     | embedding (1536)  |     +------------------+
| frontmatter(JSONB)|    | model             |
| search_vector    |     | token_count       |     +------------------+
| created_at       |     | embedded_at       |     |     tags         |
| updated_at       |     +-------------------+     |------------------|
+------------------+                                | id (PK)          |
       |                                            | page_id (FK)     |
       +-----> +--------------------+               | tag              |
       |       | timeline_entries   |               +------------------+
       |       |--------------------|
       |       | id (PK)            |
       |       | page_id (FK)       |
       |       | date               |
       |       | source             |
       |       | summary            |
       |       | detail (markdown)  |
       |       +--------------------+
       |
       +-----> +--------------------+               +------------------+
       |       |   raw_data        |               |   page_versions  |
       |       |--------------------|               |------------------|
       |       | id (PK)            |               | id (PK)          |
       |       | page_id (FK)       |               | page_id (FK)     |
       |       | source             |               | compiled_truth   |
       |       | data (JSONB)       |               | frontmatter      |
       |       +--------------------+               | snapshot_at      |
       +-----> +--------------------+               +------------------+
               |   ingest_log       |
               |--------------------|
               | id (PK)            |
               | source_type        |
               | source_ref         |
               | pages_updated      |
               | summary            |
               +--------------------+
```

索引：
- `pages.slug`：UNIQUE 约束（隐式 B 树）
- `pages.type`：B 树
- `pages.search_vector`：GIN（全文搜索）
- `pages.frontmatter`：GIN（JSONB 查询）
- `pages.title`：带有 pg_trgm 的 GIN（模糊 slug 解析）
- `content_chunks.embedding`：带有余弦运算的 HNSW（向量搜索）
- `content_chunks.page_id`：B 树
- `links.from_page_id`、`links.to_page_id`：B 树
- `tags.tag`、`tags.page_id`：B 树
- `timeline_entries.page_id`、`timeline_entries.date`：B 树

## 搜索架构

```
Query: "when should you ignore conventional wisdom?"
           |
           v
+---------------------+
| Multi-query expansion|
| (Claude Haiku)       |
| "contrarian thinking"
| "going against the crowd"
+---------------------+
     |   |   |
     v   v   v
  [embed all 3 queries]
     |   |   |
     +---+---+
         |
         v
+------------------+
| RRF Fusion       |
| score = sum(     |
|   1/(60 + rank)) |
+------------------+
         |
         v
+------------------+
| 4-Layer Dedupe |
| 1. By source     |
| 2. Cosine > 0.85 |
| 3. Type cap 60%  |
| 4. Per-page max  |
+------------------+
         |
         v
+------------------+
| Stale alerts     |
| (compiled_truth  |
|  older than      |
|  latest timeline)|
+------------------+
         |
         v
     [Results]
```

## 分块策略

| 策略 | 输入 | 算法 | 何时使用 |
|----------|-------|-----------|-------------|
| 递归 | 任何文本 | 5 级分隔符层次结构（段落 > 行 > 句子 > 子句 > 空白）。300 字块，50 字重叠。 | 时间线（可预测的格式）、批量导入 |
| 语义 | 质量文本 | 嵌入每个句子，Savitzky-Golay 过滤器用于主题边界，余弦相似度最小值。回退到递归。 | 编译的真相（智能评估） |
| LLM 引导 | 高价值文本 | 预分割为 128 字候选，Claude Haiku 在滑动窗口中查找主题偏移。每个窗口 3 次重试。 | 通过 `--chunker llm` 显式请求 |

调度：编译的真相获取语义分块器。时间线获取递归分块器。用 `--chunker` 标志或前置事务中的 `chunk_strategy` 覆盖。

## 技能（胖 markdown，无代码）

每个技能都是 AI 代理（Claude Code、OpenClaw）读取并遵循的 markdown 文件。技能包含工作流、启发式和Quality 规则。二进制文件中没有技能逻辑。

| 技能 | 它做什么 |
|-------|-------------|
| `skills/ingest/SKILL.md` | 摄取会议、文档、文章。更新编译的真相、追加时间线、创建链接。 |
| `skills/query/SKILL.md` | 3 层搜索（FTS + 向量 + 结构化）。用引用综合答案。 |
| `skills/maintain/SKILL.md` | 查找矛盾、陈旧信息、孤儿、死链接、标签不一致。 |
| `skills/enrich/SKILL.md` | 从外部 API 丰富（Crustdata、Happenstance、Exa）。存储原始数据，提炼为编译的真相。 |
| `skills/briefing/SKILL.md` | 每日简报：带有上下文的会议、活跃交易、开放线程。 |
| `skills/migrate/SKILL.md` | 从 Obsidian、Notion、Logseq、纯 markdown、CSV、JSON、Roam 通用迁移。 |

## CEO 范围扩展（为 v0 接受）

1. **CLI/MCP 奇偶校验与漂移测试。** 两个接口都是引擎上的瘦包装器。测试断言相同的输出。
2. **智能 slug 解析。** 用于读取的通过 pg_trgm 的模糊匹配。写入需要精确 slug。`gbrain get "dont scale"` 解析为 `concepts/do-things-that-dont-scale`。
3. **Brain 健康仪表板。** `gbrain health` 显示页面计数、嵌入覆盖率、陈旧页面、孤儿、死链接。
4. **规范化时间线。** 仅 `timeline_entries` 表（无 TEXT 列）。`detail` 字段支持 markdown。
5. **页面版本控制。** `page_versions` 表存储完整快照（compiled_truth + frontmatter + 链接）。`gbrain history`、`gbrain diff`、`gbrain revert` 命令。还原重新分块并重新嵌入。
6. **类型化链接 + 图遍历。** `link_type` 列（knows、invested_in、works_at 等）。`gbrain graph` 使用带有最大深度（默认 5，可通过 `--depth` 配置）的递归 CTE。
7. **Trigger.dev 数据清理作业。** 每日嵌入回填、每周陈旧检测 + 孤儿审计 + 标签一致性。
8. **陈旧警报注释。** 搜索结果标记编译的真相比最新时间线条目更陈旧的页面。
9. **摄取时时间线合并。** 跨所有提及的实体的相同事件创建。

## 安全模型（v0）

单用户，仅本地：

- Supabase 服务角色密钥在 `~/.gbrain/config.json` 中（0600 权限）
- MCP stdio 传输本质上是本地的（客户端生成 `gbrain serve` 作为子进程）
- v0 中没有多用户、没有 RLS、没有 OAuth
- 多用户路径（将来）：Supabase RLS + 每用户 API 密钥

## 升级机制

`gbrain upgrade` 检测安装方法并相应地更新：

| 路径 | 如何 |
|------|-----|
| npm | `bun update gbrain`（或 npm 等效项） |
| 编译二进制文件 | 将新二进制文件下载到临时目录，原子重命名交换，执行新进程 |
| ClawHub | `clawhub update gbrain` |

版本检查：将本地版本与最新的 GitHub 发布标签进行比较。

## 存储和成本估算

### 存储（约 750MB 用于 7,471 个页面）

| 组件 | 大小 |
|-----------|------|
| 页面文本（compiled_truth + 时间线） | ~150MB |
| JSONB 前置事务 | ~20MB |
| tsvector + GIN 索引 | ~50MB |
| 内容块（~22K，文本） | ~80MB |
| 嵌入（22K x 1536 浮点数 x 4 字节） | ~134MB |
| HNSW 索引开销（~2x 嵌入） | ~270MB |
| 链接、标签、时间线、raw_data、版本 | ~50MB |
| **总计** | **~750MB** |

Supabase 免费层（500MB）不适合。Supabase Pro（$25/月，8GB）是起点。

### 嵌入成本（约 $4-5 用于初始导入）

| 步骤 | 成本 |
|------|------|
| 语义分块器句子嵌入（~374K 句子） | ~$1 |
| 块嵌入（~22K 块） | ~$0.30 |
| 查询扩展（每个查询，~3 个嵌入） | 可忽略 |
| **总初始导入** | **~$4-5** |

预算替代方案：`gbrain import --chunker recursive` 跳过句子级嵌入，然后 `gbrain embed --rechunk --chunker semantic` 稍后升级。

## 无服务器操作堆栈

```
+------------------+     +------------------+     +------------------+
|    Supabase      |     |    Vercel         |     |   Trigger.dev    |
|  (Postgres +     |     |  (web/API,        |     |  (background     |
|   pgvector)      |     |   optional)       |     |   jobs)          |
+------------------+     +------------------+     +------------------+
| Database         |     | Future web UI     |     | Embed backfill   |
| Connection pool  |     | API endpoints     |     | Stale detection  |
| pgvector HNSW    |     | Edge functions    |     | Orphan audit     |
| tsvector FTS     |     |                   |     | Tag consistency  |
| pg_trgm fuzzy    |     |                   |     | Daily briefing   |
+------------------+     +------------------+     +------------------+
```

CLI 直接连接到 Supabase Postgres。Trigger.dev 和 Vercel 用于异步/计划工作。没有它们，CLI 也可以工作。

## 验证检查清单

1. `gbrain import /data/brain/` 无损耗地迁移所有 7,471 个文件
2. `gbrain export` 往返到语义相同的 markdown
3. `gbrain query "what does PG say about doing things that don't scale?"` 返回相关的混合搜索结果
4. `gbrain serve` 启动 MCP 服务器，可由 Claude Code 连接
5. 所有 3 个分块器都使用测试夹具产生正确的输出
6. `gbrain init --supabase` 端到端工作
7. `bun test` 通过所有测试
8. `clawhub install gbrain` 安装技能并运行引导式设置
9. `bun add gbrain` + `import { PostgresEngine } from 'gbrain'` 在外部项目中工作
10. 漂移测试通过：CLI 和 MCP 产生相同的结果
11. `gbrain health` 输出准确的 brain 健康指标
12. 迁移技能成功导入 Obsidian 保险库

## 未来计划

有关可插拔引擎架构以及未来的后端计划，请参见 `docs/ENGINES.md`。

### v1 候选（从 v0 延期）

- **`gbrain ask` 自然语言 CLI 别名。** 添加起来微不足道。P1 TODO。
- **智能编译器。** 将每个事实视为具有来源跨度、实体链接、有效时间窗口、置信度和矛盾状态的一级声明。"什么改变了，为什么，以及什么证据会再次翻转它？" 来自 Codex 评论。建立在编译的真相模型上。
- **通过 Trigger.dev 的活跃技能。** 特定于应用程序的简报、会议准备。属于 OpenClaw，而不是通用 brain 基础设施。
- **多用户访问。** Supabase RLS + 每用户 API 密钥。v0 是单用户。
- **SQLite 引擎。** 在 v1 之前被 PGLite（通过 WASM 嵌入的 Postgres 17）取代。有关当前的引擎架构，请参见 [`ENGINES.md`](ENGINES.md)。
- **用于自托管 Postgres 的 Docker Compose。** 社区 PR 受欢迎。
- **Web UI。** 可选的 Vercel 托管仪表板，用于浏览 brain 页面。

### 接口抽象原则

所有操作都通过 `BrainEngine`。引擎接口是契约。Postgres 特定的功能（tsvector、pgvector HNSW、pg_trgm、递归 CTE）是 `PostgresEngine` 内部的实现细节。接口公开功能，而不是 SQL。

这意味着：
- SQLite 引擎可以使用 FTS5 而不是 tsvector 实现 `searchKeyword`
- SQLite 引擎可以使用 sqlite-vss 而不是 pgvector 实现 `searchVector`
- 未来的 DuckDB 引擎可以实现分析繁重的工作负载
- CLI、MCP 服务器和库消费者永远不会知道下面运行哪个引擎

请参见 [`ENGINES.md`](ENGINES.md) 以获取完整的接口规范。（原始的 SQLite 引擎计划被 PGLite 取代；契约优先的 `BrainEngine` 接口使该交换干净。）

## 审查历史

| 审查 | 运行 | 状态 | 关键发现 |
|--------|------|--------|-------------|
| /office-hours | 1 | 已批准 | 构建器模式。选择完整移植方法。 |
| /plan-ceo-review | 1 | 已清除 | 11 个提案，10 个接受，1 个延期。SCOPE EXPANSION 模式。 |
| /codex review | 1 | 已发现 issues | 24 个点受到挑战，3 个接受（模糊 slug、还原规范、tsvector）。 |
| /plan-eng-review | 2 | 已清除 | 3 个问题（升级路径、导入护栏、init 向导），0 个关键差距。 |
| /plan-devex-review | 1 | 已清除 | DX 分数 5/10 到 7/10。TTHW 25 分钟到 90 秒。冠军层级。 |
