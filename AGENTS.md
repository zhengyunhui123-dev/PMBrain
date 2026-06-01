# 在 GBrain 上工作的代理

这是你的安装 + 操作协议。Claude Code 会自动读取 `./CLAUDE.md`。
其他所有人（Codex、Cursor、OpenClaw、Aider、Continue，或通过 URL 获取的 LLM）：
从这里开始。

## 安装（5 分钟）

1. 通过 Bun 安装 gbrain（规范路径）：
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   bun install -g github:garrytan/gbrain
   ```
   如果 `bun install -g` 中止或 `gbrain doctor` 报告 `schema_version: 0`，
   CLI 会打印指向 [#218](https://github.com/garrytan/gbrain/issues/218) 的恢复提示。
   运行 `gbrain apply-migrations --yes` 来恢复，或者回退到
   确定性安装：`git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`。
2. 初始化大脑：`gbrain init`（默认为 PGLite，零配置）。对于 1000+ 文件或
   多机器同步，init 会通过 Supabase 建议 Postgres + pgvector。
3. **停止 — 询问用户搜索模式。** `gbrain init` 自动应用了
   默认值，但打印了一个 9 单元格成本矩阵（模式 × 下游模型），
   前面有 `[AGENT]` 标记。你必须将矩阵传达给操作员，
   并在继续之前确认他们的选择。角点之间的成本差异是 25 倍 —
   静默接受是错误的默认行为。参见
   [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) 步骤 3.5 了解
   确切的询问用户协议。现有用户在 `gbrain post-upgrade` 时也会看到相同的横幅
   （搜索模式是在 v0.32.3 中添加的）。
4. 阅读 [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) 了解完整的 9 步流程
   （API 密钥、身份、cron、验证）。

## 阅读顺序

1. `./AGENTS.md`（本文件）— 安装 + 操作协议。
2. [`./CLAUDE.md`](./CLAUDE.md) — 架构参考、关键文件、信任边界、
   测试布局。
3. [`./docs/architecture/brains-and-sources.md`](./docs/architecture/brains-and-sources.md)
   — 双轴思维模型（brain = 哪个数据库，source = 数据库中的哪个仓库）。每个
   查询都在两个轴上路由。在编写任何涉及 brain 操作的代码之前阅读。
4. [`./skills/conventions/brain-routing.md`](./skills/conventions/brain-routing.md) —
   面向代理的决策表：何时切换 brain，何时切换 source，如何
   实现跨 brain 联邦（仅潜在空间；由代理决定）。
5. [`./skills/RESOLVER.md`](./skills/RESOLVER.md) — skill 调度器。在任何任务之前阅读。

## 信任边界（关键）

GBrain 区分**可信本地 CLI 调用者**（`OperationContext.remote = false`，
由 `src/cli.ts` 设置）和**不可信的面向代理的调用者**（`remote = true`，由
`src/mcp/server.ts` 设置）。当 `remote = true` 时，安全敏感操作（如 `file_upload`）会
加强文件系统限制，当未设置时默认为严格行为。如果你
正在编写或审查操作，请查阅 `src/core/operations.ts` 了解契约。

## 常见任务

- **配置：** [`docs/ENGINES.md`](./docs/ENGINES.md),
  [`docs/guides/live-sync.md`](./docs/guides/live-sync.md),
  [`docs/mcp/DEPLOY.md`](./docs/mcp/DEPLOY.md).
- **调试：** [`docs/GBRAIN_VERIFY.md`](./docs/GBRAIN_VERIFY.md),
  [`docs/guides/minions-fix.md`](./docs/guides/minions-fix.md), `gbrain doctor --fix`.
- **迁移 / 升级：** `gbrain upgrade`（二进制自更新 + 模式迁移 + 升级后提示），
  [`docs/UPGRADING_DOWNSTREAM_AGENTS.md`](./docs/UPGRADING_DOWNSTREAM_AGENTS.md),
  [`skills/migrations/`](./skills/migrations/), `gbrain apply-migrations --yes`（手动仅模式）。
- **评估检索变更：** 捕获默认关闭。要根据真实捕获的查询基准测试
  检索变更，请设置
  `GBRAIN_CONTRIBUTOR_MODE=1`，然后 `gbrain eval export --since 7d > base.ndjson`
  和 `gbrain eval replay --against base.ndjson`。对于公共基准测试
  覆盖（LongMemEval、ground-truth 评分），`gbrain eval longmemeval
  <dataset.jsonl>`（v0.28.8）针对每个问题在隔离的内存 PGLite 中运行 —
  你的 `~/.gbrain` 永远不会被打开。完整指南：
  [`docs/eval-bench.md`](./docs/eval-bench.md).
- **将大脑驱动到目标健康分数 (v0.36.4.0)：** 单命令
  循环。`gbrain doctor --remediation-plan --json` 预览将要
  修复的内容；`gbrain doctor --remediate --yes --target-score 90 --max-usd 5`
  执行依赖有序的计划（同步 before 提取，嵌入 after
  合并），在每个步骤之间重新检查分数，拒绝花费
  超过成本上限。空大脑（无实体页面）或未配置的嵌入
  密钥达到 `max_reachable_score` 上限并因缺少的内容而退出。
  三个阶段处理程序（synthesize / patterns / consolidate）是
  受保护的 — 只有可信的本地调用者可以提交它们；MCP 不能。
  参考：[`docs/architecture/topologies.md`](./docs/architecture/topologies.md)
  和 v0.36.4.0 的 CHANGELOG 条目。
- **随时间跟踪创始人/公司 (v0.35.7)：** 当实体在
  其 `## Facts` 围栏中具有类型化指标声明（`metric: mrr`, `value: 50000`,
  `unit: USD`, `period: monthly` 列），运行
  `gbrain eval trajectory <entity-slug>` 获取按时间顺序的历史记录，
  自动标记回归，或 `gbrain founder scorecard <entity-slug>`
  获取四信号 JSON 汇总（claim_accuracy / consistency /
  growth_trajectory / red_flags）。MCP 操作 `find_trajectory` 暴露了
  相同的数据 — 读取范围，对远程调用者进行可见性过滤。**v0.40.2.0：**
  `gbrain think` 现在在 temporal /
  knowledge_update 意图上自动使用此基底（默认开启；翻转 `think.trajectory_enabled=false`
  以退出）。迁移 v82 添加了 `facts.event_type`，因此非指标事件
  行（`meeting`、`job_change`、`location_change`）通过相同的
  管道传输；将 `kind: 'event'` 或 `'all'` 传递给 `find_trajectory` 以查询
  它们。
- **其他所有内容：** [`./llms.txt`](./llms.txt) 是完整的文档地图。
  [`./llms-full.txt`](./llms-full.txt) 是相同的地图，核心文档内联用于
  单次获取摄取。

## 发布前

最简单的方法：`bun run ci:local` 在 Docker 内运行完整的 CI 门禁（gitleaks、
未设置 `DATABASE_URL` 的单元测试，然后针对新的 pgvector 容器按顺序运行所有 29 个 E2E 文件）并拆除。在专注于某个分支的快速迭代期间，使用 `bun run ci:local:diff` 获取
感知差异的子集。需要 Docker
（Docker Desktop / OrbStack / Colima）和 `gitleaks`（`brew install gitleaks`）。

手动路径：`bun test` 加上 `./CLAUDE.md` 中描述的 E2E 生命周期（启动
测试 Postgres 容器，运行 `bun run test:e2e`，拆除它）。

通过 `/ship` skill 发布，不要手动发布。

## 隐私

永远不要将人员、公司或基金会的真实姓名提交到公共制品中。请参阅
`./CLAUDE.md` 中的隐私规则。GBrain 页面引用真实联系人；公共文档必须
使用通用占位符（`alice-example`、`acme-example`、`fund-a`）。

## 分支

如果你是分支版本，在发布前使用你自己的 URL 基础重新生成 `llms.txt` + `llms-full.txt`：
`LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms`。
