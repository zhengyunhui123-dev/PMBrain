# GBrain AI Agent 安装指南

请完整阅读本文件，然后按照步骤操作。需要时向用户询问 API 密钥。
目标：约 30 分钟完成完整的 brain 设置。

## 步骤 0：如果你不是 Claude Code

首先阅读仓库根目录的 `AGENTS.md`。这是非 Claude agent 的操作协议（安装、读取顺序、信任边界、常见任务）。Claude Code 会自动读取 `CLAUDE.md`，可以直接跳过此步骤。

如果你通过 URL 获取此文件但尚未克隆仓库，配套文件位于：
- `https://raw.githubusercontent.com/garrytan/gbrain/master/AGENTS.md` — 从这里开始
- `https://raw.githubusercontent.com/garrytan/gbrain/master/llms.txt` — 完整文档地图
- `https://raw.githubusercontent.com/garrytan/gbrain/master/llms-full.txt` — 相同地图，内联版本

## 步骤 1：安装 GBrain

默认路径（需要 Bun — gbrain 是 Bun + TypeScript 运行时）：

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:garrytan/gbrain
```

验证：`gbrain --version` 应该输出版本号。如果找不到 `gbrain`，重启 shell 或将 PATH 导出添加到 shell 配置文件。

> **如果 `bun install -g` 中止或 `gbrain doctor` 报告 `schema_version: 0`**（Bun 偶尔会在全局安装时阻止顶层 postinstall 钩子，导致 schema 迁移无法自动运行），CLI 会打印指向 [#218](https://github.com/garrytan/gbrain/issues/218) 的恢复提示。运行 `gbrain apply-migrations --yes` 进行恢复。如果不起作用，回退到确定性安装路径：
>
> ```bash
> git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain
> bun install && bun link
> ```

## 步骤 2：API 密钥

向用户询问以下密钥。gbrain 默认使用 ZeroEntropy 嵌入 + 重排序堆栈（从 v0.36.2.0 开始）；仍支持通过 `gbrain config set embedding_model <provider:model>` 将 OpenAI/Voyage 作为回退。

```bash
export ZEROENTROPY_API_KEY=ze-...     # 默认嵌入 + 重排序 (v0.36.2.0+)
export OPENAI_API_KEY=sk-...          # 向量搜索回退；也用于聊天模型
export ANTHROPIC_API_KEY=sk-ant-...   # 可选，通过查询扩展提高搜索质量
```

保存到 shell 配置文件或 `.env`。密钥会被 `gbrain config set` 自动获取，或可以存储在 `~/.gbrain/config.json`（文件平面）中。如果没有任何嵌入提供商，关键词搜索仍然有效。如果没有 Anthropic，搜索仍然有效但会跳过查询扩展。

## 步骤 3：创建 Brain

```bash
gbrain init                           # PGLite，无需服务器
gbrain doctor --json                  # 验证所有检查通过
```

用户的 markdown 文件（笔记、文档、brain 仓库）与此工具仓库是**分离**的。询问用户他们的文件在哪里，或创建一个新的 brain 仓库：

```bash
mkdir -p ~/brain && cd ~/brain && git init
```

阅读 `~/gbrain/docs/GBRAIN_RECOMMENDED_SCHEMA.md` 并在用户的 brain 仓库中（**不是**在 ~/gbrain 中）设置 MECE 目录结构（people/、companies/、concepts/ 等）。

## 步骤 3.5：与用户确认搜索模式（**请勿跳过**）

`gbrain init` 自动应用了默认搜索模式（除非你的子 agent 层级是 Haiku 级或未配置 OpenAI 密钥，否则为 `tokenmax`）。init 输出包含以下成本矩阵，前面有 `[AGENT]` 标记。你**必须**不能静默接受默认值。停止并询问操作员。

**逐字呈现此矩阵：**

```
每查询成本 @ 10K 查询/月（典型单用户量）：

                  Haiku 4.5     Sonnet 4.6    Opus 4.7
                  ($1/M)        ($3/M)        ($5/M)
  conservative    $40/月        $120/月       $200/月
  balanced        $100/月       $300/月       $500/月
  tokenmax        $200/月       $600/月       $1,000/月

（线性扩展：100K/月 ×10，1K/月 ÷10。角落间相差 25 倍。
 自然对角配对 — 便宜/便宜 → 前沿/前沿 — 跨度约 4 倍。）
```

**询问操作员（如需要可改述）：**

> 你的 gbrain 刚刚以搜索模式 `<自动应用的默认值>` 安装。这是
> 一个一次性设置决策，控制检索负载大小。你想要哪种模式？
>
>   1) conservative — 严格 4K 预算，无 LLM 扩展，最多 10 个块。
>      最适合 Haiku 子 agent、成本敏感设置、高容量循环。
>
>   2) balanced — 12K 预算，无扩展，25 个块。Sonnet 层级的最佳选择。
>
>   3) tokenmax（推荐默认值 — 保留 v0.31.x 检索形状）—
>      无预算，LLM 扩展开启，50 个块。最适合 Opus/前沿模型。
>
> 成本取决于模式**和**你运行的下游模型。请参阅上面的矩阵了解 9 单元格细分。

如果操作员选择非默认模式，运行：
```bash
gbrain config set search.mode <mode>
```

如果他们选择 tokenmax **并且**想要保留字面 v0.31.x 默认值（limit=20 而不是 tokenmax 的 50），还要运行：
```bash
gbrain config set search.searchLimit 20
```

在继续之前用 `gbrain search modes` 验证选择。

**为什么这很重要：** 矩阵角落之间的成本差距是 25 倍。一个静默接受默认值并开始针对未预期 tokenmax 级上下文负载的用户运行查询的 agent，可能会产生意外的支出。在继续之前进行确认。

## 步骤 4：导入和索引

```bash
gbrain import ~/brain/ --no-embed     # 导入 markdown 文件
gbrain embed --stale                  # 生成向量嵌入
gbrain query "这些文档的主要主题是什么？"
```

## 步骤 4.5：连接知识图谱

如果用户已经有 brain 仓库（步骤 3 导入了现有 markdown），回填类型链接图谱和结构化时间线。这会填充 `links` 和 `timeline_entries` 表，未来的写入将自动维护这些表。

```bash
gbrain extract links --source db --dry-run | head -20    # 预览
gbrain extract links --source db                         # 提交
gbrain extract timeline --source db                      # 日期事件
gbrain stats                                             # 验证 links > 0
```

对于全新的空 brain，跳过此步骤 — auto-link 会在 agent 向前写入页面时填充图谱。还没有什么可以回填。

此步骤后：
- `gbrain graph-query <slug> --depth 2` 正常工作（关系遍历）
- 搜索对连接良好的实体排名更高（反向链接提升）
- 每个未来的 `put_page` 自动创建类型链接并协调过时的链接

如果用户的 brain 非常大（>10K 页面），`extract --source db` 是幂等的，并支持 `--since YYYY-MM-DD` 进行增量运行。

## 步骤 5：加载技能

如果你正在运行 agent 平台（OpenClaw、Hermes 或任何有工作区的仓库），将捆绑的技能脚手架到其中：

```bash
cd /path/to/agent/workspace
gbrain skillpack scaffold --all       # 复制 43 个精选技能 + RESOLVER.md
```

脚手架的技能是你仓库中的一等文件。自由编辑；重新运行脚手架会拒绝覆盖已存在的任何内容。当你想要上游改进时，使用 `gbrain skillpack reference <name>` 与 gbrain 的捆绑包进行差异比较。（旧的 `gbrain skillpack install` 管理块模型已在 v0.36.0.0 中退役 — 如果从旧版本升级，运行一次 `gbrain skillpack migrate-fence`。）

无论你是否脚手架，阅读 `skills/RESOLVER.md`（在你的工作区中，或从克隆的仓库运行的捆绑副本 `~/gbrain/skills/RESOLVER.md`）。这是技能调度器 — 告诉你对于任何任务应该阅读哪个技能。将此永久保存到你的记忆中。

要立即采用的最重要的三个技能：

1. **信号检测器**（`skills/signal-detector/SKILL.md`）— 在每个入站消息上触发。它并行捕获想法和实体。brain 会复合增长。

2. **Brain-ops**（`skills/brain-ops/SKILL.md`）— 每个响应上的 brain 优先查找。在任何外部 API 调用之前检查 brain。

3. **约定**（`skills/conventions/quality.md`）— 引用格式、反向链接铁律、来源归属。这些是不可协商的质量规则。

## 步骤 6：身份（可选）

运行 soul-audit 技能来自定义 agent 的身份：

```
阅读 skills/soul-audit/SKILL.md 并遵循它。
```

这会根据用户的回答生成 SOUL.md（agent 身份）、USER.md（用户配置文件）、ACCESS_POLICY.md（谁看到什么）和 HEARTBEAT.md（操作节奏）。

如果跳过，会自动安装最小默认值。

## 步骤 7：定期任务

使用你平台的调度器（OpenClaw cron、Railway cron、crontab）设置，或使用 `gbrain autopilot --install`（内置自维护守护进程）完全跳过平台粘合：

- **实时同步**（每 15 分钟）：`gbrain sync --repo ~/brain && gbrain embed --stale`
  — 或使用 `gbrain sync --watch` 进行连续循环。
- **自动更新**（每天）：`gbrain check-update --json`（告诉用户，永远不要自动安装）。
- **梦境周期**（每晚）：`gbrain dream` 运行 8 阶段夜间维护周期。实体扫描、引用修复、记忆巩固，加上（v0.23+）夜间对话合成和跨会话模式检测。一个 cron 友好的命令。这就是让 brain 复合增长的原因。不要跳过它。请参阅 `docs/guides/cron-schedule.md` 了解完整协议。
- **每周**：`gbrain doctor --json && gbrain embed --stale`

## 步骤 8：集成

运行 `gbrain integrations list`。`~/gbrain/recipes/` 中的每个配方都是独立的安装程序。它告诉你要询问什么凭据、如何验证以及注册什么 cron。询问用户他们想要哪些集成（电子邮件、日历、语音、Twitter）。

验证：`gbrain integrations doctor`（在至少配置一个之后）

## 步骤 9：验证

阅读 `docs/GBRAIN_VERIFY.md` 并运行所有 7 个验证检查。检查 #4（实时同步实际工作）是最重要的。

## 升级

如果你通过 `bun install -g` 安装：

```bash
gbrain upgrade                        # 自更新二进制文件，运行 schema 迁移，
                                      # 并打印版本范围的升级后说明
```

如果你通过 `git clone + bun link` 安装：

```bash
cd ~/gbrain && git pull origin master && bun install
gbrain apply-migrations --yes         # 应用 schema 迁移（幂等）
gbrain post-upgrade                   # 显示版本范围的迁移说明
```

然后阅读 `~/gbrain/skills/migrations/v<NEW_VERSION>.md`（以及你跳过的任何中间版本）并运行它列出的任何回填或验证步骤。跳过这一步就是功能在二进制文件中发布但在用户的 brain 中保持休眠的方式。

**v0.32.3 搜索模式（一次性升级提示）：** 如果用户的 brain 是在 v0.32.3 之前创建的，`gbrain post-upgrade` 会打印一个横幅，包括 9 单元格成本矩阵（模式 × 下游模型），前面有 `[AGENT]` 标记。**不要**静默越过横幅。逐字向操作员呈现矩阵，询问他们想要哪种模式（推荐默认值：`tokenmax` 以保留 v0.31.x 检索形状），然后运行 `gbrain config set search.mode <mode>`。请参阅上面的步骤 3.5 了解完整的询问用户协议 — 升级路径使用相同的矩阵和相同的默认值。

对于 v0.12.0+  specifically：如果你的 brain 是在 v0.12.0 之前创建的，运行 `gbrain extract links --source db && gbrain extract timeline --source db` 来回填新的图谱层（请参阅上面的步骤 4.5）。

对于 v0.12.2+ specifically：如果你的 brain 是 Postgres 或 Supabase 支持的并且早于 v0.12.2，`v0_12_2` 迁移会在 `gbrain post-upgrade` 期间自动运行 `gbrain repair-jsonb` 来修复双重编码的 JSONB 列。PGLite brain 无操作。如果 wiki 风格的导入被旧的 `splitBody` bug 截断，升级后运行 `gbrain sync --full` 以从源 markdown 重新构建 `compiled_truth`。

## v0.42.0+ 入驻表面（新）

`gbrain onboard` 是 gbrain 以前没有的激活表面。一旦你的 brain 有任何内容，运行 `gbrain onboard --check --json` 来查看跨 5 个 brain 健康轴的结构化建议（孤儿、过时嵌入、实体链接覆盖率、时间线覆盖率、takes 计数）。

**在首次连接时（after `gbrain init`）：**
```bash
gbrain onboard --check --json
```
JSON 信封（`schema_version: 1`）携带 `recommendations[]`，每个项目都有 `apply_policy`：`auto_apply`（安全无人值守运行）、`prompt_required`（需要明确用户同意）或 `manual_only`（承载 LLM，用户必须自己运行）。

**在每次 `gbrain upgrade` 之后：**
```bash
gbrain onboard --check --json
```
新版本可能会出现新的机会。升级后横幅会在运行时提示用户，但 agent 无论如何都应该作为卫生步骤重新探测。

**无人值守修复（cron / autopilot）：**
```bash
gbrain onboard --auto --max-usd 5
```
没有 `--max-usd N` 会拒绝。仅运行自动符合条件的项目。autopilot 守护进程也会在其 tick 上咨询入驻建议 — 自主路径不需要明确的 agent 操作。

**远程 / 联邦 brain 安装（MCP）：**
`run_onboard` MCP op（admin 范围）允许瘦客户端 agent 通过 OAuth 认证的 MCP 探测 brain 健康 + 驱动修复。受保护的承载 LLM 的处理程序（synthesize、patterns、consolidate、takes-bootstrap、contextual_reindex_per_chunk）需要额外的 `run_protected_onboard` 范围 — 仅 admin 是不够的。MCP op 返回 `skipped_missing_scope[]`，列出如果有正确授权会运行什么。

**隐私 + 同意门：**
- `gbrain takes extract --from-pages` 将 concept/atom/lore/briefing/writing/originals 页面内容发送到你配置的聊天模型（默认 Anthropic Haiku）。除非在配置中设置 `takes.bootstrap_enabled=true` **并且**传递 `--yes`，否则拒绝运行。设计上的双门选择。
- autopilot 的 takes-bootstrap 自动应用层级保持 `manual_only` 直到 v0.42.1 的 eval 门（不要绕过）。

**在 CI / 脚本环境中抑制提示：**
```bash
export GBRAIN_NO_ONBOARD_NUDGE=1
```

Init + 升级横幅在非 TTY 中也会自动跳过。