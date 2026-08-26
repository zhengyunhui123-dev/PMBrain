# 在现有 brain 上切换嵌入模型或维度

PMBrain 在 `content_chunks` 上的固定维度 `vector(N)` 列中存储嵌入。如果你切换到具有不同维度的模型（例如 `openai:text-embedding-3-large` 1536 → `zeroentropyai:zembed-1` 1280，或 `voyage:voyage-4-large` 2048），磁盘列类型不会自动更改。

`pmbrain init`、`pmbrain doctor` 和 `pmbrain embed --stale` 都会检测这种不匹配，并拒绝静默继续。本文档是它们指向的配方。

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

PMBrain 不采用 PMBrain 的“整库擦除后从 Markdown 重新同步”路径。PMBrain 数据库还包含 GUI 创建知识、来源、标签、回收站、权限和审核状态，这些内容不一定存在于 Markdown/Git 中。

先创建并验证升级冷备：

```bash
pmbrain pglite-backup create \
  --target-version manual
```

该命令只在取得单目录独占迁移锁后复制数据库。源目录与冷备进行文件数、字节数和 SHA-256 校验；随后再复制出一次性恢复副本，实际打开它并读取 schema 版本和关键持久表计数。冷备本体不会被打开或迁移。备份保存在当前生效配置目录（默认新安装为 `~/.pmbrain`，兼容旧安装和 `PMBRAIN_HOME` / `GBRAIN_HOME` 覆盖）：

```text
<config-dir>/backups/pglite-upgrades/<timestamp>-<target-version>-<id>/
  brain.pglite/
  manifest.json
```

可随时重新验证：

```bash
pmbrain pglite-backup verify --backup <backup-directory>
```

桌面端的“软件修复”页面会通过下面的命令列出当前数据库对应的已验证升级备份：

```bash
pmbrain pglite-backup list [--path <brain.pglite>]
```

`list` 只读取备份目录中的 `manifest.json`。自动升级成功后只保留最近 2 份；也可以用 `prune`、`delete`、`restore` 清理或恢复，并用 `set-root` 把备份目录改到其他磁盘。恢复会替换当前数据库，备份本身仍保留。

验证完成后，只重建明确列入派生数据白名单的向量和缓存：

```bash
pmbrain models align-embedding-dimension --yes
pmbrain embed --stale
```

`models align-embedding-dimension` 保留页面、chunk 文本、来源、标签、权限、审核状态和其他未知表，只重建向量列、派生 embedding、查询缓存和相关索引。未知数据默认归类为受保护数据。

桌面端在检测到 PGLite 需要升级时会自动执行同一冷备流程；备份验证通过后才启动唯一 sidecar 迁移。迁移失败时保留数据库、备份和日志，不自动覆盖。旧 `reinit-pglite` 命令在 PMBrain 中保留为安全拒绝入口，不再移动或擦除整个数据库。

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
--    让它无索引并依赖精确扫描（PMBrain searchVector 自动处理 —
--    搜索只是变慢，不会损坏）。
-- 对于 dims <= 2000（例如 1024、1280、1536、768）：
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- 对于 dims > 2000（例如 2048 Voyage 4 Large）：跳过步骤 4。

COMMIT;
```

然后使用新模型重新初始化配置：

```bash
pmbrain init --supabase \
  --embedding-model <provider:model> \
  --embedding-dimensions <NEW_DIMS>
```

并重新嵌入：

```bash
pmbrain embed --stale
```

## 关于 `pmbrain config set` 的说明

v0.37 之前的文档推荐 `pmbrain config set embedding_model X` 来切换模型。**这对嵌入管道是无操作。** `config set` 写入 DB 平面；嵌入网关读取文件平面（`~/.pmbrain/config.json`）。v0.37 之前的配方提供了谎言，因为契约没有公开。

PMBrain 中，`config set embedding_model` 和 `config set embedding_dimensions` 会拒绝绕过安全流程的直接修改，并提示使用经过确认的模型切换与派生数据重建路径。

PGLite 使用 `pmbrain models align-embedding-dimension --yes`；Postgres 使用上面的事务 SQL 配方。两条路径都必须由用户明确确认，不能在普通升级时隐式清空向量。

## 验证

配方生效后，`pmbrain doctor --fast` 应报告绿色，`pmbrain doctor` 应通过 `embedding_width_consistency` 检查：

```
✓ embedding_width_consistency   dim parity: config 1280 / column vector(1280)
```

如果没有，请提交带有 doctor 输出和你运行的步骤的 issue。

## v0.37+ 后续

- 当主 provider 失败配额/身份验证时，自动回退到替代嵌入 provider。跟踪；需要显式 `--try-fallback` 同意，因为混合 provider 向量会静默损坏检索。
