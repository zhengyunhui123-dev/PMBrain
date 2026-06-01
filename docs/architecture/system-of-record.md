# 记录系统

**GitHub 仓库（markdown + frontmatter）是记录系统。
Postgres/PGLite 数据库是派生缓存。我们不会备份
数据库 — 我们从仓库重建它。**

本文档是该契约的规范参考。每个写入用户知识状态的代码
路径都应与此处描述的模式匹配。
`scripts/check-system-of-record.sh` 中的 CI 门
以编程方式强制执行它。

## 为何这很重要

数据库是 markdown 内容上的派生索引。它的存在是为了使
搜索快速，对嵌入相似主张进行去重，以实现
跨页面图谱。这些数据都不是不可替代的 — 只要
markdown 完整，`gbrain sync && gbrain extract all` 从头开始重建
整个数据库。

这意味着：

- **灾难恢复是一个命令。** 如果你的数据库卷损坏，如果
  Postgres 吞噬自身，如果 PGLite 的 WASM 锁卡住 — 你不需要
  备份。你擦除数据库，从你的大脑仓库重新导入，并且
  派生状态重新生成。v0.32.3 发布 `gbrain rebuild
  --confirm-destructive` 作为文档化的单线。
- **多机器同步是 git。** 你的大脑是一个仓库。从一台
  机器推送，从另一台机器拉取，并且第二台机器的数据库在
  其下一次同步时重建。没有"备份数据库"步骤。
- **隐私在你手中。** 敏感实体页面可以
  git 忽略（通过 `gbrain.yml` `db_only` 路径或每页面），并且它们
  保留在磁盘上，但不在 git 中。栅栏尊重你在
  页面级别做出的任何 git 跟踪选择。
- **跨代理协作是可能的。** 多个代理可以写入
  同一个大脑，因为栅栏是合并点，而不是数据库。
  Git 处理并发编辑的方式与 git 处理并发编辑的方式相同。

## 三个类别

gbrain schema 中的每个表恰好属于三个类别之一。
该类别决定在灾难恢复期间如何重建它。

### FS-规范（markdown 是真相源）

这些是由用户创作的知识。数据库行是
markdown 上的派生索引 — 擦除表并且 `gbrain extract` 重建它
完全相同。CI 门防止直接数据库写入偏离
markdown 契约。

| 类别 | 它如何在 markdown 中存储 | 派生数据库表 | 协调器 |
|---|---|---|---|
| **主张** (包括 hunches、bets) | `## Takes` 在 `<!--- gbrain:takes:begin -->` / `:end -->` 标记之间的封闭式表格 | `takes` | `extract takes` |
| **事实** | `## Facts` 在 `<!--- gbrain:facts:begin -->` / `:end -->` 标记之间的封闭式表格 | `facts` | `extract_facts` 循环阶段 |
| **链接** | Markdown 正文 + frontmatter `direction: incoming` 中的内联 `[text](slug)` / `[[slug]]` | `links` | `extract links` |
| **时间线** | `<!-- timeline -->` 标记后的 `## Timeline` 部分 | `timeline_entries` | `extract timeline` |
| **标签** | Frontmatter `tags:` YAML 数组 | `tags` | `importFromFile`（在导入时每页面协调） |
| **emotional_weight** | 从主张 + 标签重新计算 | `pages.emotional_weight`（信号列） | `recompute_emotional_weight` 循环阶段 |

### 从 FS 派生但不是用户创作的

这些保存派生状态，这些状态可以从
markdown 自动重建，但不是由用户直接创作为 markdown。
分块器 + 嵌入器在导入时重建这些。

| 表 | 来源 | 说明 |
|---|---|---|
| `pages` | markdown 文件作为一个整体 | 每个文件一行；`compiled_truth` + `frontmatter` 来自解析 |
| `content_chunks` | `pages.compiled_truth` 在分块器剥离后 | 在 content_hash 更改时重新分块；通过配置的模型嵌入 |
| `page_versions` | 每个 `pages` UPDATE | 审计历史记录；原则上可重建，但实际上不行 |

### 按设计仅 DB（已命名例外）

这些保存运行时 / 基础设施状态，这些状态特意不
在仓库中。架构规则仍然成立 — 这些不是
"用户知识" — 但按设计它们是仅 DB 的。

| 类别 | 为何可以仅 DB |
|---|---|
| `raw_data` | Webhook/脚本 sidecar；不是用户创作的知识。 |
| `subagent_messages` / `subagent_tool_executions` / `subagent_rate_leases` | 运行时作业状态。仅重放，不是持久性知识。 |
| `oauth_clients` / `oauth_tokens` / `access_tokens` | 凭证。按定义不在源代码控制中。 |
| `mcp_request_log` | 审计跟踪。按设计易失。 |
| `minion_jobs` / `minion_inbox` / `minion_attachments` | 作业队列。重新启动重新排队或丢弃。 |
| `eval_candidates` / `eval_capture_failures` | 贡献者模式开发循环；选择加入捕获。 |
| `dream_verdicts` | 廉价裁决缓存。通过重新运行 Haiku 可重建。 |
| `gbrain_cycle_locks` / 迁移分类帐 | 基础设施。 |
| `config`（某些键） | 站点本地路由配置（例如 `sync.repo_path`）。 |

必须首先针对 FS 落地保存用户知识的新派生表。
如果你倾向于将其添加为"暂时仅 DB"，则结构性
问题是：它是否属于此仅 DB 设计列表？如果不是，
那么它是 FS-规范的，并且需要栅栏（或 frontmatter 字段）加上
协调器。

## 隐私边界

栅栏中的私有知识仍然存在于 markdown 文件中。如果
用户将页面提交到 git，则私有数据也会进入 git。这是
现有的操作模型 — 我们不会推断 git 策略。

对于不受信任的读取者（远程 MCP、subagent），v0.32.2 发布
一个 3 层剥离：

1. **层 A（分块器）：** `src/core/chunkers/recursive.ts` 调用
   `stripFactsFence({keepVisibility: ['world']})` + `stripTakesFence`
   在分块之前。私有事实文本永远不会到达
   `content_chunks.chunk_text`、嵌入或搜索结果。
2. **层 B (get_page)：** 当 `ctx.remote === true` 时，响应
   正文会剥离两个栅栏（来自事实的私有行；整个
   主张栅栏）。本地 CLI（`ctx.remote === false`）会看到完整的
   栅栏。
3. **层 C（git 跟踪）：** 用户决定是否提交
   实体页面。`gbrain.yml` `db_only` 路径会自动
   git 忽略；通过用户的正常 git 工作流进行每页面选择。

对于普遍私有的实体（朋友的名字、投资者的
内部笔记），在 `gbrain.yml` 中将实体页面的目录标记为 `db_only`。
该文件保留在磁盘上，但永远不会进入 git。

## 遗忘契约

`gbrain forget <id>` 和 MCP `forget_fact` 操作会使用删除线 + `valid_until = today` + `context: "forgotten:
<reason>"` 重写栅栏
行。数据库的 `expired_at = valid_until + now()` 派生
在每次重建时重建遗忘状态，因为栅栏是
规范的。

删除线具有两种不同的语义，由上下文区分：

- `~~claim~~` + `context: "superseded by #N"` → 行已被
  同一栅栏中的较新行替换
- `~~claim~~` + `context: "forgotten: <reason>"` → 行已被撤回
  通过遗忘操作

两种编码都将行保留在 markdown 中用于审计历史记录。要
永久删除事实，请直接在 markdown 中编辑栅栏并
删除行。下一次 `extract_facts` 循环会擦除数据库行。

## 灾难恢复

规则做出的承诺：

```bash
# 快照那里的内容
gbrain stats > /tmp/before.txt

# 擦除并重建
gbrain rebuild --confirm-destructive   # v0.32.3 — 删除派生表
                                       # (pages + content_chunks survive
                                       # the CASCADE-safe design)
                                       # OR manually for v0.32.2:
psql -c 'DELETE FROM facts; DELETE FROM takes; DELETE FROM links; DELETE FROM timeline_entries;'
gbrain sync
gbrain extract all

# 计数匹配
gbrain stats > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

不变式 E2E 测试位于 `test/e2e/system-of-record-invariant.test.ts`
在每个 CI 运行中执行此精确流程。

## 新规则

当你添加新的用户知识类别时：

1. **定义 markdown 形状。** 栅栏 (`<!--- gbrain:NAME:begin
   --> ... :end -->` 表）或 frontmatter 字段。
2. **构建解析器**，该解析器从 markdown 生成结构化数据。
   请参阅 `src/core/fence-shared.ts` 以了解共享基元。
3. **构建写入器**，该写入器进行往返：解析 + 编辑 + 渲染生成
   用于相同输入的逐字节 markdown。
4. **添加引擎方法**，该方法获取解析的数据并标记
   派生表。该方法在 CI 门的
   禁止直接调用列表中获得一个条目。
5. **添加协调器：** 一个循环阶段，该阶段遍历页面、解析
   栅栏并从头开始重建派生表。协调器
   是引擎方法的唯一合法调用站点；
   `// gbrain-allow-direct-insert: <reason>` 显式注释它。
6. **在 `test/e2e/system-of-record-invariant.test.ts` 中添加往返
   测试**，该测试证明 DELETE + 协调器逐字节重建表。

`scripts/check-system-of-record.sh` 中的 CI 门无法任何 PR，该 PR
在协调器 / 迁移层之外向派生表写入器添加新的直接调用，而没有显式允许列表注释。

## 相关

- `~/.claude/plans/system-instruction-you-are-working-expressive-pony.md`
  — v0.32.2 设计计划（决定 D1-D22 + Q1-Q8，Codex round 1
  和 round 2 发现）
- `skills/migrations/v0.32.2.md` — 面向代理的迁移指南
- `CHANGELOG.md` v0.32.2 条目 — 发布宣言
- `scripts/check-system-of-record.sh` — 强制执行
  规则的 CI 门
