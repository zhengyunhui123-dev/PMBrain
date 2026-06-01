# GBrain 基础设施层

所有技能、配方和集成构建于其上的共享基础。

## 数据管道

```
输入（markdown 文件、git 仓库）
  ↓
文件解析（本地 → .redirect → .supabase → 错误）
  ↓
MARKDOWN 解析器（gray-matter frontmatter + 正文）
  → compiled_truth + 时间线分离
  ↓
内容哈希（SHA-256 幂等性检查 — 如果未更改则跳过）
  ↓
分块（3 种策略，可配置）
  ├── 递归：300 词块，50 词重叠，5 级分隔符层次结构
  ├── 语义：嵌入句子，余弦相似度，Savitzky-Golay 平滑
  └── LLM 引导：Claude Haiku 在 128 词候选者中识别主题偏移
  ↓
嵌入（OpenAI text-embedding-3-large，1536 维）
  → 批量 100，指数退避，如果失败则为非致命性
  ↓
数据库事务（原子性：页面 + 块 + 标签 + 版本）
  ↓
搜索（混合，立即可用）
```

## 搜索架构

GBrain 使用互惠排名融合（RRF）来合并向量和关键词搜索：

```
用户查询
  ↓
扩展（可选：Claude Haiku 生成 2 个替代措辞）
  ↓
  ├── 向量搜索（pgvector HNSW，余弦距离）
  │     → 每个查询变体 2 倍限制结果
  │
  └── 关键词搜索（PostgreSQL tsvector，ts_rank）
        → 2 倍限制结果
  ↓
RRF 合并（得分 = Σ(1/(60 + 排名))，公平地平衡两者）
  ↓
4 层去重
  ├── 每页面最佳 3 个块（来源去重）
  ├── Jaccard 相似度 > 0.85（文本去重）
  ├── 无类型超过 60%（多样性）
  └── 每页面最多 2 个块（页面上限）
  ↓
前 N 个结果（默认 20）
```

## 关键组件

| 文件 | 用途 |
|------|---------|
| `src/core/engine.ts` | 可插拔引擎接口（BrainEngine） |
| `src/core/postgres-engine.ts` | Postgres + pgvector 实现 |
| `src/core/import-file.ts` | importFromFile + importFromContent 管道 |
| `src/core/sync.ts` | 基于 git 的增量更改检测 |
| `src/core/markdown.ts` | YAML frontmatter + compiled_truth/timeline 解析 |
| `src/core/embedding.ts` | OpenAI 嵌入，带有批处理、重试、退避 |
| `src/core/chunkers/recursive.ts` | 基础分块器（300 词，5 级分隔符） |
| `src/core/chunkers/semantic.ts` | 基于嵌入的主题边界检测 |
| `src/core/chunkers/llm.ts` | Claude Haiku 引导的分块 |
| `src/core/search/hybrid.ts` | 向量 + 关键词的 RRF 合并 |
| `src/core/search/dedup.ts` | 4 层结果去重 |
| `src/core/search/expansion.ts` | 通过 Claude Haiku 进行多查询扩展 |
| `src/core/storage.ts` | 可插拔存储（S3、Supabase、本地） |
| `src/core/operations.ts` | 契约优先的操作定义（31 个操作） |
| `src/schema.sql` | 完整 DDL（10 个表、RLS、tsvector、HNSW） |

## Schema 概览

Postgres 中的 10 个表：

- **pages** — slug（唯一）、type、title、compiled_truth、timeline、frontmatter (JSONB)
- **content_chunks** — pgvector 1536 维嵌入，chunk_source（compiled_truth|timeline）
- **links** — 类型化边（knows、works_at、invested_in、founded 等）
- **tags** — 多对多页面标记
- **timeline_entries** — 结构化事件（日期、来源、摘要、详细信息）
- **page_versions** — 用于差异/还原的快照历史记录
- **raw_data** — 来自外部 API 的 sidecar JSON（保留来源）
- **files** — 存储后端中的二进制附件
- **ingest_log** — 导入操作的审计跟踪
- **config** — 大脑级设置（版本、嵌入模型、分块策略）

全文搜索使用加权 tsvector：title (A)、compiled_truth (B)、timeline (C)。
向量搜索在 content_chunks.embedding 上使用带有余弦距离的 HNSW 索引。

## 薄工具原理

GBrain 是确定性层。技能和配方是潜在空间层。

有关完整的
架构理念，请参阅 [薄工具，胖技能](../ethos/THIN_HARNESS_FAT_SKILLS.md)。

- **GBrain CLI** = 薄工具（相同输入 → 相同输出）
- **技能**（摄取、查询、维护、丰富、简报、迁移、设置）= 胖技能
- **配方**（语音到大脑、电子邮件到大脑）= 安装基础设施的胖技能

代理读取技能/配方并使用 GBrain 的确定性工具来
完成工作。
