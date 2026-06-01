# 可插拔引擎架构

## 理念

每个 GBrain 操作都通过 `BrainEngine`。引擎是"brain 能做什么"和"它如何存储"之间的契约。换掉引擎，保留其他一切。

v0 发布了由 Supabase 支持的 `PostgresEngine`。v0.7 增加了 `PGLiteEngine` — 通过 WASM 嵌入的 Postgres 17.5（`@electric-sql/pglite`），零配置默认。接口的设计使得 `DuckDBEngine`、`TursoEngine` 或任何自定义后端都可以插入，而无需触及 CLI、MCP 服务器、技能或任何消费者代码。

## 为什么这很重要

不同用户有不同的约束：

| 用户 | 需求 | 最佳引擎 |
|------|-------|-------------|
| 入门者 | 零配置，无账户，无服务器 | PGLiteEngine（v0.7 起默认） |
| 高级用户（你） | 世界级搜索，7K+ 页面，零运维 | PostgresEngine + Supabase |
| 开源黑客 | 单文件，无服务器，git 友好 | PGLiteEngine |
| 团队/企业 | 多用户，RLS，审计跟踪 | PostgresEngine + 自托管 |
| 研究员 | 分析，批量导出，嵌入 | DuckDBEngine（将来某天） |
| 边缘/移动 | 离线优先，稍后同步 | PGLiteEngine + 同步（将来某天） |

引擎接口意味着我们不必选择。PGLite 是零摩擦默认值。Supabase 是生产规模路径。`gbrain migrate --to supabase/pglite` 在它们之间移动。

## 接口

```typescript
// src/core/engine.ts

export interface BrainEngine {
  // 生命周期
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;

  // 页面 CRUD
  getPage(slug: string): Promise<Page | null>;
  putPage(slug: string, page: PageInput): Promise<Page>;
  deletePage(slug: string): Promise<void>;
  listPages(filters: PageFilters): Promise<Page[]>;

  // 搜索
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;

  // 块
  upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(slug: string): Promise<Chunk[]>;

  // 链接
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  removeLink(from: string, to: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
  traverseGraph(slug: string, depth?: number): Promise<GraphNode[]>;

  // 标签
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;

  // 时间线
  addTimelineEntry(slug: string, entry: TimelineInput): Promise<void>;
  getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // 原始数据
  putRawData(slug: string, source: string, data: object): Promise<void>;
  getRawData(slug: string, source?: string): Promise<RawData[]>;

  // 版本
  createVersion(slug: string): Promise<PageVersion>;
  getVersions(slug: string): Promise<PageVersion[]>;
  revertToVersion(slug: string, versionId: number): Promise<void>;

  // 统计 + 健康
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // 摄取日志
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: IngestLogOpts): Promise<IngestLogEntry[]>;

  // 配置
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  // 迁移 + 高级（v0.7 添加）
  runMigration(sql: string): Promise<void>;
  getChunksWithEmbeddings(slug: string): Promise<ChunkWithEmbedding[]>;
}
```

### 关键设计选择

**基于 slug 的 API，而非基于 ID。** 每个方法都接受 slug，而非数字 ID。引擎在内部将 slug 解析为 ID。这使得接口可移植... slug 是字符串，ID 是特定于数据库的。

**嵌入不在引擎中。** 引擎存储嵌入并通过向量搜索，但它不生成嵌入。`src/core/embedding.ts` 处理这个。这是故意的：嵌入是外部 API 调用（OpenAI），而非存储问题。所有引擎共享相同的嵌入服务。

**分块不在引擎中。** 同样的逻辑。`src/core/chunkers/` 处理分块。引擎存储和检索块。所有引擎共享相同的分块器。

**搜索返回 `SearchResult[]`，而非原始行。** 引擎负责自己的搜索实现（tsvector vs FTS5，pgvector vs sqlite-vss），但必须返回统一的结果类型。RRF 融合和去重在引擎之上，在 `src/core/search/hybrid.ts` 中。

**`traverseGraph` 存在但是特定于引擎的。** Postgres 使用递归 CTE。SQLite 会使用带深度跟踪的循环。接口是相同的：给我一个 slug 和最大深度，返回图。

## 搜索如何跨引擎工作

```
                        +-------------------+
                        |  hybrid.ts        |
                        |  (RRF 融合 +    |
                        |   去重, 共享)  |
                        +--------+----------+
                                 |
                    +------------+------------+
                    |                         |
           +--------v--------+       +--------v--------+
           | engine.search   |       | engine.search   |
           |   Keyword()     |       |   Vector()      |
           +-----------------+       +-----------------+
                    |                         |
        +-----------+-----------+   +---------+---------+
        |                       |   |                   |
+-------v-------+  +-------v---+   +-------v---+  +----v--------+
| Postgres:     |  | PGLite:   |   | Postgres: |  | PGLite:     |
| tsvector +    |  | tsvector +|   | pgvector  |  | pgvector    |
| ts_rank +     |  | ts_rank   |   | HNSW      |  | HNSW        |
| websearch_to_ |  | (same SQL)|   | cosine    |  | cosine      |
| tsquery       |  |           |   |           |  | (same SQL)  |
+---------------+  +-----------+   +-----------+  +-------------+
```

RRF 融合、多查询扩展和 4 层去重是与引擎无关的。它们对 `SearchResult[]` 数组进行操作。只有原始关键字和向量搜索是特定于引擎的。

## PostgresEngine（v0，已发布）

**依赖项：** `postgres`（porsager/postgres）、`pgvector`

**使用的 Postgres 特定功能：**

- `tsvector` + `GIN` 索引用于全文搜索，带 `ts_rank` 权重
- `pgvector` HNSW 索引用于余弦相似度向量搜索
- `pg_trgm` + `GIN` 用于模糊 slug 解析
- 用于图遍历的递归 CTE
- 基于触发器的 search_vector（跨 pages + timeline_entries）
- 带 GIN 索引的 JSONB 用于前置事务
- 通过 Supabase Supavisor 的连接池（端口 6543）

**托管：** Supabase Pro（25 美元/月）。零运维。托管 Postgres，内置 pgvector。

**为什么 v0 不自托管：** brain 应该是 AI 代理使用的基础设施，而不是你维护的东西。带 Docker 的自托管 Postgres 是受欢迎的社区 PR，但 v0 针对零运维进行了优化。

## PGLiteEngine（v0.7，已发布）

**依赖项：** `@electric-sql/pglite`（v0.4.4+）

**它是什么：** 通过 ElectricSQL 的 PGLite 编译为 WASM 的嵌入式 Postgres 17.5。在进程中运行，无服务器，无 Docker，无账户。与 PostgresEngine 相同的 SQL — 不是单独的方言。所有 37 个 BrainEngine 方法都已实现。

**PGLite 特定细节：**

- 使用 `pglite-schema.ts` 用于 DDL（pgvector 扩展、pg_trgm、触发器、索引）
- 贯穿的参数化查询（在 `src/core/utils.ts` 中的共享实用程序）
- 当 `OPENAI_API_KEY` 未设置时的 `hybridSearch` 仅关键字回退
- 数据存储在 `~/.gbrain/brain.db`（可配置）
- 用于余弦相似度向量搜索的 pgvector HNSW 索引（与 Postgres 相同）
- 用于全文搜索的 tsvector + ts_rank（与 Postgres 相同）
- 用于模糊 slug 解析的 pg_trgm（与 Postgres 相同）

**何时使用 PGLite vs Postgres：**

| 因素 | PGLite | PostgresEngine + Supabase |
|--------|--------|--------------------------|
| 设置 | `gbrain init`（零配置） | 账户 + 连接字符串 |
| 规模 | < 1,000 个文件时良好 | 10K+ 时已验证用于生产 |
| 多设备 | 仅单机器 | 任何设备通过远程 MCP |
| 成本 | 免费 | Supabase Pro（25 美元/月） |
| 并发 | 单进程 | 连接池 |
| 备份 | 手动（文件复制） | 由 Supabase 管理 |

**迁移：** `gbrain migrate --to supabase` 导出所有内容（页面、块、嵌入、链接、标签、时间线）并导入到 Supabase。`gbrain migrate --to pglite` 则相反方向。双向，无损。

## 添加新引擎

1. 创建实现 `BrainEngine` 的 `src/core/<name>-engine.ts`
2. 在 `src/core/engine-factory.ts` 中添加引擎工厂：
   ```typescript
   export function createEngine(type: string): BrainEngine {
     switch (type) {
       case 'pglite': return new PGLiteEngine();
       case 'postgres': return new PostgresEngine();
       case 'myengine': return new MyEngine();
       default: throw new Error(`Unknown engine: ${type}`);
     }
   }
   ```
   工厂使用动态导入，因此引擎仅在选中时加载。
3. 在 `~/.gbrain/config.json` 中存储引擎类型：`{ "engine": "myengine", ... }`
4. 添加测试。测试套件应尽可能与引擎无关... 相同的测试用例，不同的引擎构造函数。
5. 在此文件中记录并添加 `docs/` 中的设计文档。

### 你不需要触碰的东西

- `src/cli.ts`（分派到引擎，不知道是哪一个）
- `src/mcp/server.ts`（相同）
- `src/core/chunkers/*`（跨引擎共享）
- `src/core/embedding.ts`（跨引擎共享）
- `src/core/search/hybrid.ts`、`expansion.ts`、`dedup.ts`（共享，对 SearchResult[] 进行操作）
- `skills/*`（胖 markdown，与引擎无关）

### 你确实需要实现的东西

`BrainEngine` 中的每个方法。完整接口。没有可选方法，没有特性标志。如果你的引擎不能进行向量搜索（例如，纯文本引擎），实现 `searchVector` 返回 `[]` 并记录限制。

## 能力矩阵

| 能力 | PostgresEngine | PGLiteEngine | 备注 |
|-----------|---------------|-------------|-------|
| CRUD | 完整 | 完整 | 相同的 SQL |
| 关键字搜索 | tsvector + ts_rank | tsvector + ts_rank | 相同（真正的 Postgres） |
| 向量搜索 | pgvector HNSW | pgvector HNSW | 相同（真正的 Postgres） |
| 模糊 slug | pg_trgm | pg_trgm | 相同（真正的 Postgres） |
| 图遍历 | 递归 CTE | 递归 CTE | 相同的 SQL |
| 事务 | 完整 ACID | 完整 ACID | 两者都支持这个 |
| JSONB 查询 | GIN 索引 | GIN 索引 | 相同 |
| 并发访问 | 连接池 | 单进程 | PGLite 限制 |
| 托管 | Supabase、自托管、Docker | 本地文件 | |
| 迁移方法 | runMigration、getChunksWithEmbeddings | 相同 | v0.7 添加 |

## 未来的引擎想法

**TursoEngine。** 带有嵌入式副本和 HTTP 边缘访问的 libSQL（SQLite 分支）。将提供 SQLite 的简单性以及云同步。对于移动/边缘用例很有趣。

**DuckDBEngine。** 分析工作负载。批量导出、嵌入分析、brain 范围的统计。不适用于 OLTP。可以作为用于分析的次级引擎， alongside Postgres 用于操作。

**自定义/远程。** 接口足够干净，有人可以构建由任何存储支持的引擎：Firestore、DynamoDB、REST API，甚至平面文件系统。接口不假设 SQL。

注意：原始的 SQLite 引擎计划（`docs/SQLITE_ENGINE.md`）已被 PGLite 取代。PGLite 使用与 Postgres 相同的 SQL，消除了对带有 FTS5/sqlite-vss 翻译的单独 SQLite 方言的需求。
