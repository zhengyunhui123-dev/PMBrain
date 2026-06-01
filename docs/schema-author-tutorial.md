# 教程：构建您的第一个schema pack

您将fork捆绑的`gbrain-base` pack，添加一个自定义`researcher`页面类型，导入几个占位符researcher页面，用一个命令回填它们的`page.type`列，然后通过运行`gbrain whoknows`并看到您的新类型在结果中出现来证明接线工作正常。结束状态：磁盘上fork并激活的pack，~5个类型为`researcher`的页面，以及证明pack感知路由端到端触发的查询。

**想要在HOW之前了解WHY？** 先阅读[`what-schemas-unlock.md`](what-schemas-unlock.md) — 7个具体使用案例（4000个不可见会议，创始人ops brain，研究brain，法律brain，团队brain，agent作为共同策展人）加上为什么类型在查询时间很重要的结构性论证。然后回到这里进行5分钟演练。

整个演练大约需要5分钟。您将在步骤3看到一些工作的东西。

## 您需要什么

- gbrain v0.40.7.0或更高版本（`gbrain --version`检查）
- 已初始化的brain（`gbrain init`已运行；PGLite或Postgres都可以）
- 您可以粘贴命令的终端

就这样。本教程不需要API密钥 — 每个步骤都针对捆绑pack和仅本地命令工作。

## 步骤1：查看今天激活的pack

```bash
gbrain schema active --json
```

您会看到类似：

```json
{
  "pack_name": "gbrain-base",
  "version": "1.0.0",
  "sha8": "...",
  "page_types_count": 22,
  "source_tier": "default"
}
```

`source_tier: "default"`意味着您没有自定义任何东西 — 您使用的是捆绑pack。`page_types_count: 22`是通用启动器（person, company, meeting, note等）。

**您无法直接修改捆绑pack。** 步骤2fork它，以便您有可写的东西。

## 步骤2：Fork捆绑pack

```bash
gbrain schema fork gbrain-base mine
```

输出：`Forked 'gbrain-base' → 'mine' at ~/.gbrain/schema-packs/mine/pack.json`。

fork是`gbrain-base`的逐字节副本，位于`~/.gbrain/schema-packs/mine/pack.json`。现在您有一个可以变异的可写pack。

## 步骤3：激活fork

```bash
gbrain schema use mine
```

输出：`Pack: mine (json) ... Active.`

再次运行`gbrain schema active --json`以确认`pack_name`现在是`mine`，`source_tier`是`home-config`（从`~/.gbrain/config.json`读取）。

**您已经完成了一些可见的事情** — 活动pack已更改，任何未来的查询都将通过您的fork路由。接下来的四个步骤添加自定义类型并证明其工作。

## 步骤4：添加researcher类型

```bash
gbrain schema add-type researcher \
  --primitive entity \
  --prefix people/researchers/ \
  --extractable \
  --expert
```

输出：`Pack: mine (json)` + `Sha8: <prev> → <new>`。

刚刚发生了什么：
- 变异通过`withMutation`的8步骨架：捆绑保护 → 每pack锁 → 读取 → 变异 → 文件平面lint验证 → 原子写入 → 审计日志 → 缓存失效。
- pack现在将`researcher`声明为绑定到`people/researchers/`的实体原语，标记为`extractable: true`（符合事实提取条件）和`expert_routing: true`（在`whoknows`查询中出现）。
- 审计行落在`~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl`中，您的类型名称SHA-8编辑和前缀的第一段 only（`people`）用于隐私。

验证类型是否在pack中：

```bash
gbrain schema explain researcher
```

您将看到解析的设置打印回来。

## 步骤5：导入一些占位符researcher页面

您需要在`people/researchers/`下的页面，以便下一步做任何事情。如果您的brain仓库已经有它们，请跳过。如果没有，请将3-5个占位符markdown文件放到`<your-brain-repo>/people/researchers/`中并导入：

```bash
mkdir -p people/researchers
cat > people/researchers/alice-example.md <<'EOF'
---
title: Alice Example
---

ML researcher at Example Lab. Works on contrastive embeddings.
EOF

cat > people/researchers/bob-example.md <<'EOF'
---
title: Bob Example
---

Vision researcher at Widget University. Recent paper on diffusion models.
EOF

cat > people/researchers/charlie-example.md <<'EOF'
---
title: Charlie Example
---

RL researcher at Acme Research. Focus on inverse reinforcement learning.
EOF

gbrain sync
```

同步导入新文件。它们将存储在数据库中，但它们的`type`列仍将为空 — 在这些页面已经存在之后（代理走进现有brain的典型现实场景），新类型被添加到pack中。

## 步骤6：使用`stats`查看差距

```bash
gbrain schema stats --json | jq '.aggregate, .dead_prefixes'
```

您将看到`untyped_pages: 3`（或您刚刚导入的任意数量）和`dead_prefixes: []` — 您的新前缀有3个匹配页面，因此它没有死。

3个researcher页面按类型"孤立"，即使它们位于正确的目录中。下一步回填它们。

## 步骤7：使用`sync --apply`回填

首先干运行以查看会发生什么：

```bash
gbrain schema sync --json
```

您会看到类似：

```json
{
  "schema_version": 1,
  "apply": false,
  "per_prefix": [
    {
      "type": "researcher",
      "prefix": "people/researchers/",
      "would_apply": 3,
      "sample_slugs": ["people/researchers/alice-example", "people/researchers/bob-example", "people/researchers/charlie-example"],
      "applied": 0
    }
  ],
  "total_would_apply": 3,
  "total_applied": 0
}
```

`would_apply: 3`是您将触及的。`sample_slugs`是代理的drilldown信号 — 如果那些slug看起来不对，中止。它们看起来对，所以应用：

```bash
gbrain schema sync --apply
```

您将在stderr上看到每批次进度行和最终的`total_applied: 3`。UPDATE以1000为块运行（您的适合一个块），永远不会阻塞任何并发写入器。

## 步骤8：证明接线工作

```bash
gbrain whoknows "machine learning"
```

如果您的researcher页面包含ML相关内容，它们将在排名结果中出现 — 即使它们类型为`researcher`，而不是`person`或`company`。

**这是T1.5接线的重要演示。** 在v0.40.7.0之前，`whoknows`硬编码`['person', 'company']`作为符合资格的类型，并会完全忽略您的`researcher`页面。v0.40.7.0接线通过`expertTypesFromPack(pack.manifest)`咨询活动pack的`expert_routing: true`类型，因此您的自定义类型现在通过专家搜索路由。

## 您构建了什么

您现在拥有：
- 名为`mine`的`gbrain-base`fork，位于`~/.gbrain/schema-packs/mine/pack.json`，通过`~/.gbrain/config.json`在您的brain中激活。
- 在pack中注册的`researcher`页面类型，具有`entity`原语，`people/researchers/`前缀，`extractable: true`，`expert_routing: true`。
- 3个类型为`researcher`的页面（通过`gbrain schema sync --apply`从磁盘回填）。
- 通过新类型路由的查询路径：`gbrain whoknows`读取pack并在其类型过滤器中包含`researcher`。

您还演练了完整的变异骨架：捆绑pack保护，每pack锁，验证门，原子写入，审计日志，缓存失效。每个步骤都是幂等的 — 重新运行任何步骤都是无操作。

## 下一步

**添加链接动词。** 一个`researcher`可以`author`一个`paper`。要建模：

```bash
gbrain schema add-type paper --primitive annotation --prefix research/papers/ --extractable
gbrain schema add-link-type authored --page-type researcher --target-type paper
gbrain schema graph
```

图现在显示`researcher --(authored)--> paper`。

**为查询闭包添加别名。** 如果您希望`gbrain query researcher`也显示`person`行（因为researchers就是people）：

```bash
gbrain schema add-alias researcher person
```

阅读[`skills/conventions/schema-evolution.md`](../skills/conventions/schema-evolution.md)以获取何时添加类型vs别名vs前缀的决策树。简短版本：<20页 → 不要pack编码；20-100 → 现有类型上的别名；100+ → 一级类型。

**在发布前lint您的pack。** 11规则lint表面（带有用于DB感知检查的`--with-db`标志）捕获悬空引用，前缀冲突和dead-corpus警告：

```bash
gbrain schema lint --with-db
```

**将您的pack提交到源代码控制。** 如果`~/.gbrain/schema-packs/mine/`是git仓库，请提交`pack.json`并推送。您的pack跨机器生存，`mutation_count_anomaly` lint规则将在您一周内点击>50个变异时提示您（"您应该提交这个"信号）。

**对于代理（MCP）：** 相同的操作可通过9个新操作通过HTTPS MCP访问。注册管理员范围OAuth客户端，`schema_apply_mutations`允许远程代理将多步重构编写为一个原子批次。批处理MCP操作 + 每pack锁 + 审计日志是使远程schema编写安全的重要原语。参见[`skills/schema-author/SKILL.md`](../skills/schema-author/SKILL.md)以获取代理调度程序。

**撤消错误。** 每个变异原语都有一个逆操作（`remove-type`, `remove-alias`, `remove-prefix`, `remove-link-type`, `set-extractable false`等）。如果您fork两次并想要还原，`gbrain schema downgrade`从`~/.gbrain/schema-pack-history.jsonl`恢复先前的活动pack。

## 相关文档

- **参考：** `gbrain schema --help`获取完整的22动词CLI表面；CLAUDE.md的"Schema Cathedral v3 (v0.40.7.0)"部分获取逐模块架构。
- **操作指南：** [`skills/schema-author/SKILL.md`](../skills/schema-author/SKILL.md) — 带有7阶段工作流的代理调度程序（brain → 评估 → 提议 → 应用 → 同步 → 验证 → 提交）。
- **解释：** [`skills/conventions/schema-evolution.md`](../skills/conventions/schema-evolution.md) — 何时添加类型vs别名vs前缀。
- **计划 + 决策：** 原始设计捕获了21个决策，包括捆绑pack保护基本原理（D6），空过滤器回退合同（D4）和MCP非localOnly信任姿态（D2）。位于`~/.claude/plans/system-instruction-you-are-working-recursive-thacker.md`（私有）。
