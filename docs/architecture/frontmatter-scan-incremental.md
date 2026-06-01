# Frontmatter 扫描：基于数据库增量状态（Phase 2 设计草图）

**状态：** 已设计，未构建。在此处捕获为
v0.38.2.0 之后后续 PR 的起始点。

## 为什么存在这个

v0.38.2.0 修复了导致 `gbrain doctor` 在大型大脑上
挂起的承重错误类：磁盘遍历器在每个时钟周期都会 descend 到 `node_modules/`、`.git/` 和
其他供应商树中。在该修复之后，在大多数大脑上，doctor 会在
几秒钟内完成，并且在任何大脑上都有界挂钟时间（默认 30 秒，具有诚实的
部分状态 surfacing）。

但是 `frontmatter_integrity` 的稳定状态成本在真实
可同步页面中仍然是 O(N)：每个 doctor 时钟周期都会重新遍历文件系统并重新解析
每个 `.md` 文件。对于拥有 200K+ 页面的用户，即使在修复 1 之后，
稳定状态成本也在数秒内。
为了达到亚秒级稳定状态 doctor（正确的形状，用于
cron 监控的运行状况检查），扫描需要变得
是增量的。

本文档在后续 PR 启动之前捕获 Phase 2 设计，
因此实现者不必重新推导它。

## 目标

Doctor 的 `frontmatter_integrity` 检查在 O(1) SQL 查询中完成，
无论大脑大小如何，都具有与 v0.38.2.0 的有界遍历方法相同的每来源细分和 partial-
state 语义。增量刷新
作为同步端写入 + 自动驾驶循环阶段运行，因此稳定状态
工作被摊销到已经接触每个文件的工作流中。

## Schema

新表：

```sql
CREATE TABLE frontmatter_scan_state (
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,  -- 相对于 source.local_path
  mtime_ms     BIGINT NOT NULL,
  content_hash TEXT NOT NULL,  -- 扫描时文件内容的 sha256
  codes        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ParseValidationCode[]
  last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, path)
);

CREATE INDEX frontmatter_scan_state_has_issues_idx
  ON frontmatter_scan_state (source_id)
  WHERE codes != '[]'::jsonb;
```

为什么是这些列：

- `mtime_ms` + `content_hash`：增量检查选择其中一个。mtime 更快
  （无读取）；content_hash 是事实（击败无更改的 touch 情况）。
  增量遍历器使用 mtime 作为快速门控，并在 mtime 表明已更改时使用 content_hash 作为
  回退。
- `codes` JSONB：每行错误代码列表，NULL/`[]` 表示干净。Doctor
  使用 `jsonb_array_length(codes) > 0` 进行聚合。
- 在 `WHERE codes != '[]'::jsonb` 上的部分索引：doctor 的聚合查询
  仅遍历有问题的行，这只是页面的一小部分。

这遵循 `src/core/pglite-engine.ts`（和 `postgres-engine.ts`）中的规范 `applyForwardReferenceBootstrap` 模式 — 新列 /
表添加进入引导探测集，根据 CLAUDE.md，以便旧大脑
在 schema 链中向前遍历时不会因为表
不存在而卡住。

## 迁移形状

```ts
// src/core/migrate.ts — 在 v80 条目之后追加
const migrations = [
  // ...现有 v1-v80...
  {
    version: 81,
    name: 'frontmatter_scan_state',
    sql: `
      CREATE TABLE IF NOT EXISTS frontmatter_scan_state (...);
      CREATE INDEX IF NOT EXISTS frontmatter_scan_state_has_issues_idx ...;
    `,
  },
];
```

加上两个引擎引导程序中的前向引用探测条目。加上
`test/schema-bootstrap-coverage.test.ts` 中的 `REQUIRED_BOOTSTRAP_COVERAGE` 扩展。

## 写入器

两条路径写入行：

1. **同步端写入**（规范性）。`src/core/sync.ts:performSync` 已经
   解析它接触的每个文件。在现有 `parseMarkdown` 调用之后，
   `UPSERT` 到 `frontmatter_scan_state` 以及文件的路径 / mtime /
   content_hash / codes。成本：每个同步的文件有一行。零额外解析
   工作 — 解析已经发生了。

2. **增量扫描**（`gbrain frontmatter scan --incremental`）。通过 `walkBrainTree` 遍历
   磁盘，对于每个文件，检查 `mtime > last_scanned_at`
   OR `content_hash != stored`，仅重新解析已更改的文件。大多数时钟周期：
   第一次完整回填后零工作。也作为自动驾驶
   循环阶段（`frontmatter_scan`）公开，因此它与其他周期性
   维护阶段一起运行。

增量遍历器处理同步遗漏的两种情况：

- 在同步之外编辑的文件（用户打开编辑器、保存、从不 `git
  提交`）。
- 其 `local_path` 不是 git 仓库的来源（同步仅看到 git 触及的
  文件）。

## Doctor 读取器

```ts
// src/commands/doctor.ts:frontmatter_integrity (Phase 2 形状)
const rows = await engine.executeRaw<{ source_id: string; issues: number }>(
  `SELECT source_id, count(*) FILTER (WHERE jsonb_array_length(codes) > 0)::int AS issues
   FROM frontmatter_scan_state
   GROUP BY source_id`,
);
```

一个 SQL 查询，恒定时间，无论大脑大小如何。来自
v0.38.2.0 的 partial-state
surfacing 保持不变 — 当 `frontmatter_scan_state` 过时
（对于已注册的来源没有行，或者对于任何
来源，`last_scanned_at` > 24 小时旧）时，doctor 会警告新鲜度，而不是将潜在-
过时数据报告为权威数据。

## 排序问题

1. **首次扫描。** 全新升级在
   `frontmatter_scan_state` 中没有行。两个选项：
   - 惰性：doctor 报告"尚未扫描状态；运行 `gbrain frontmatter scan
     --incremental` 一次"（操作员驱动）。
   - 急切：创建表的迁移也会将自动驾驶
     循环作业排队以进行首次完整扫描。

   建议：惰性，并带有明确的提示。自动驾驶路径是较重的
   surface（必须将新的 `frontmatter_scan` 阶段添加到现有
   cycle.ts 机制和 doctor 路由的后台作业系统）。

2. **来源归档 / 删除。** `frontmatter_scan_state` 在 `sources(id)` 上具有 `ON DELETE
   CASCADE`，因此软删除 + 72 小时 TTL + 清除已经
   清理它。不需要额外的逻辑。

3. **来源内的路径重命名。** 同步会通过
   路径（通过周期性协调步骤）`DELETE` 旧行并 `INSERT` 新行。如果没有
   该步骤，表会累积过时的路径行。要么：
   - 增量扫描器中的协调步骤：在遍历期间未看到的任何路径行都会
     被删除。
   - 或者：doctor 将"frontmatter_scan_state 中的 N 个过时行"报告为
     新鲜度信号，并将 `gbrain frontmatter scan --reconcile` 作为
     修复措施。

## 成本估算

- 每个同步的文件一次 UPSERT。与同步已经执行的解析 + 数据库写入相比，
  可以忽略不计。
- 增量刷新运行时间：主要受 mtime 统计信息支配。在 SSD 上，每 1000 个文件约需 ~ms。
- Doctor 读取：一个索引化 SQL 查询。在任何大脑大小下都低于 100 毫秒。

## 此设计特意不做什么

- **替换 v0.38.2.0 的有界遍历安全网。** Phase 2 使
  稳定状态变得便宜，但磁盘遍历器（带有其截止时间检查）保持
  作为扫描状态缺失或
  过时的来源的真相源回退。万无一失。
- **引入单独的 frontmatter 验证规则集。** 重用
  `parseMarkdown(..., {validate: true})` 和现有的
  `ParseValidationCode` 枚举。单一真相源。
- **添加新的后台守护程序。** 连接到现有的
  `autopilot-cycle` Minion 处理程序作为新阶段，以及同步 /
  提取 / 嵌入 / 等。

## 给实现者的开放性问题

1. **路径规范化。** `pages.source_path` 和磁盘遍历器的
   相对路径计算相似但不完全相同（斜杠、
   前导 `./` 等）。增量扫描器需要匹配同步
   存储的内容，以便 UPSERT 键正确。在写入之前进行审核。
2. **软删除交互。** 在数据库中软删除的页面
   （v0.26.5）在磁盘上仍然有文件。增量扫描是否应该
   继续跟踪其 frontmatter 状态？可能是的（因此未来的
   `restore_page` 不会因过时的 frontmatter 而感到惊讶），但值得
   与软删除所有者确认。
3. **两阶段推出。** 首先落地表和写入，让它回填
   一个发布周期，然后切换 doctor 读取器。避免
   "Phase 2 已发布但表为空"的情况，即 doctor 回归到
   报告"无扫描状态"。

## TODO 文件条目

```
- [ ] 实施 Phase 2：基于数据库的 frontmatter 扫描状态。
      设计位于 docs/architecture/frontmatter-scan-incremental.md。
      迁移 v81 + 同步端 UPSERT + 增量扫描命令
      + 自动驾驶循环阶段 + doctor 读取器。两阶段推出：首先落地
      表 + 写入；一个发布后翻转读取器。
```
