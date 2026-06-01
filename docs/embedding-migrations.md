# 在现有 brain 上切换嵌入模型或维度

GBrain 在 `content_chunks` 上的固定维度 `vector(N)` 列中存储嵌入。如果你切换到具有不同维度的模型（例如 `openai:text-embedding-3-large` 1536 → `zeroentropyai:zembed-1` 1280，或 `voyage:voyage-4-large` 2048），磁盘列类型不会自动更改。

`gbrain init`、`gbrain doctor` 和 `gbrain embed --stale` 都会检测这种不匹配，并拒绝静默继续。本文档是它们指向的配方。

## 为什么我们不会自动执行此操作

切换维度需要：

1. 删除 HNSW 向量索引（pgvector 无法在 `ALTER COLUMN TYPE` 中存活）。
2. 更改列类型（仅限 Postgres — PGLite 无法执行此操作）。
3. 清除每个现有嵌入（旧向量在新空间中无法使用）。
4. 重新嵌入整个语料库（在 50K 页面的 brain 上可能需要数小时，并根据模型花费 $1-100 的 API 调用）。
5. 有条件地重新创建索引（HNSW 每个 pgvector 最多支持 2000 个维度；超过这个维度，你必须使用精确扫描）。

这不是升级时自动运行的操作。这是一个谨慎的、昂贵的操作。当你决定实际想要新模型时运行它。

## PGLite（默认安装）

**PGLite 无法 `ALTER COLUMN TYPE vector(N)`。** pgvector 作为嵌入式 WASM 提供，而不是本机扩展，WASM 构建以 `could not access file "$libdir/vector"` 拒绝列类型更改。下面的 SQL 配方仅适用于 Postgres。

在 PGLite 上工作的路径是**擦除并重新初始化**。v0.37 提供了一个单命令包装器：

```bash
gbrain reinit-pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280
```

这将现有 brain 备份到 `<path>.bak`，使用新标志运行 `gbrain init`（保留 `~/.gbrain/config.json` 中的每个其他字段），并重新同步 brain 仓库。添加 `--no-sync` 以跳过重新同步，`--yes` 以跳过 TTY 确认，`--json` 以获取结构化输出。

手动等效：

```bash
# 1. 备份现有 brain（以防你想回滚）。
mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak

# 2. 使用新模型 + 维度重新初始化。`gbrain init` 写入
#    调整为新 dim 的 schema，并且（从 v0.37 开始）保留
#    ~/.gbrain/config.json 中的每个其他字段（聊天模型、
#    扩展模型、API 密钥）。
gbrain init --pglite \
  --embedding-model zeroentropyai:zembed-1 \
  --embedding-dimensions 1280

# 3. 重新导入你的 brain 仓库。`gbrain sync` 从磁盘读取 brain 仓库
#    并重新创建页面行。
gbrain sync

# 4. 重新嵌入。嵌入管道现在使用新模型和
#    列接受新 dim。
gbrain embed --stale
```

如果你的 brain 仓库足够大，从磁盘重新同步很昂贵（>50K 页面），请参阅下面的 Postgres 部分 — 临时迁移到 Postgres 让你运行 SQL 配方，然后迁移回 PGLite。

`GBRAIN_HOME` 用户：替换活动数据库路径（或使用 `gbrain config get database_path` 查找它）。

## Postgres（Supabase / 自托管）

Postgres 支持就地列更改。将 `<NEW_DIMS>` 替换为你的目标维度计数。

```sql
BEGIN;

-- 1. 删除 HNSW 索引。它无法在列类型更改中存活。
DROP INDEX IF EXISTS idx_chunks_embedding;

-- 2. 更改列类型。
ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(<NEW_DIMS>);

-- 3. 清除陈旧嵌入，使其不会在新空间中存活。
UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;

-- 4. 仅当 dims <= 2000 时重新创建 HNSW 索引。超过这个，
--    让它无索引并依赖精确扫描（gbrain searchVector 自动处理 —
--    搜索只是变慢，不会损坏）。
-- 对于 dims <= 2000（例如 1024、1280、1536、768）：
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- 对于 dims > 2000（例如 2048 Voyage 4 Large）：跳过步骤 4。

COMMIT;
```

然后使用新模型重新初始化配置：

```bash
gbrain init --supabase \
  --embedding-model <provider:model> \
  --embedding-dimensions <NEW_DIMS>
```

并重新嵌入：

```bash
gbrain embed --stale
```

## 关于 `gbrain config set` 的说明

v0.37 之前的文档推荐 `gbrain config set embedding_model X` 来切换模型。**这对嵌入管道是无操作。** `config set` 写入 DB 平面；嵌入网关读取文件平面（`~/.gbrain/config.json`）。v0.37 之前的配方提供了谎言，因为契约没有公开。

从 v0.37 开始，`gbrain config set embedding_model` 和 `gbrain config set embedding_dimensions` 拒绝并打印擦除并重新初始化配方。

要更改 schema 大小调整字段，请使用 `gbrain init`（PGLite）或 SQL 配方（Postgres）。两者都一起更新文件平面和 schema。

## 验证

配方生效后，`gbrain doctor --fast` 应报告绿色，`gbrain doctor` 应通过 `embedding_width_consistency` 检查：

```
✓ embedding_width_consistency   dim parity: config 1280 / column vector(1280)
```

如果没有，请提交带有 doctor 输出和你运行的步骤的 issue。

## v0.37+ 后续

- 当主 provider 失败配额/身份验证时，自动回退到替代嵌入 provider。跟踪；需要显式 `--try-fallback` 同意，因为混合 provider 向量会静默损坏检索。
