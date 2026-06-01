# 升级下游代理

GBrain在`skills/`中发布skills。下游代理（自定义OpenClaw部署，任何类型的代理fork）经常**复制**这些skill文件到自己的工作空间，并随着时间的推移而偏离 — 添加代理特定的阶段，删除不相关的阶段，收紧语言。一旦发生这种情况，gbrain就无法将更新推送到那些fork。代理必须手动应用差异。

本文档列出了下游代理在升级时需要应用的确切差异。根据您的fork的本地skill文件进行交叉引用。

## 为什么存在这个

`gbrain upgrade`发布新的二进制文件。`gbrain post-upgrade [--execute --yes]`运行schema迁移并回填数据。但是告诉代理如何行为的**skill文件本身**是用户拥有的。如果您的`~/git/<your-agent>/workspace/skills/brain-ops/SKILL.md`在顶部显示`# Based on gbrain v0.10.0`，它不知道v0.12.0的功能。

代理将在每个`put_page`之后继续手动调用`gbrain link`（现在冗余 — 自动链接执行此操作），错过用于关系问题的`gbrain graph-query`，并且不知道回填结构化时间线。

## 如何应用

1. 识别您的forked skill文件。通常位于`~/git/<your-agent>/workspace/skills/`或您的代理的skill目录所在的任何位置。
2. 对于下面列出的每个skill，在您的fork中找到匹配的阶段/部分。
3. 应用差异（在指示的位置粘贴新块）。
4. 更新fork顶部的版本横幅（`# Based on gbrain v0.12.0`）。
5. 验证：要求代理编写一个测试页面，并确认响应包括`auto_links: { created, removed, errors }`。

总时间：所有四个skills约10分钟。

---

## 1. brain-ops/SKILL.md

**位置：** 在`### Phase2: On Every Inbound Signal`之后立即插入新的`### Phase2.5`部分。

**为什么：** Phase2.5声明自动链接自动运行。没有这个，代理的心智模型说它必须在每个`put_page`之后调用`gbrain link`，现在这是冗余的，并且可能导致双重添加警告。

```markdown
### Phase2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- To disable: `gbrain config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `gbrain timeline-add`
  (or batch via `gbrain extract timeline --source db`).
```

**还要更新Iron Law部分。** 如果您的fork仍然说"Back-links maintained on every brain write (Iron Law)"而没有限定条件，请附加：

```markdown
**v0.12.0 update:** Auto-link satisfies the Iron Law for entity-reference links
on every `put_page`. The agent's Iron Law obligation is now: include the
entity reference in the page content (e.g., `[Alice](people/alice)`); auto-link
handles the structured row. Manual `add_link` calls are reserved for
relationships you can't express in markdown content.
```

---

## 2. meeting-ingestion/SKILL.md

**位置：** 附加到`### Phase3: Attendee enrichment`的末尾。

**为什么：** 消除每个参会者的冗余`gbrain link`调用（当会议页面将参会者引用为`[Name](people/slug)`时，自动链接处理它们）。

```markdown
**Note (v0.12.0):** Once the meeting page is written via `gbrain put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `gbrain link` for attendees. You DO still need `gbrain timeline-add`
for dated events (auto-link only handles links, not timeline entries).
```

**位置：** 在`### Phase4: Entity propagation`中，可以将"Back-link from entity page to meeting page"这一行替换为：

```markdown
4. Entity references in the meeting page body auto-create the link via auto-link.
   For incoming references on the entity page (entity page → meeting page), edit
   the entity page to mention the meeting and `put_page` it — auto-link handles
   the rest.
```

---

## 3. signal-detector/SKILL.md

**位置：** 附加到`### Phase2: Entity Detection`的末尾。

**为什么：** 与brain-ops相同的逻辑 — 消除写入引用people或companies的originals/ideas页面后的手动`gbrain link`。

```markdown
**Auto-link (v0.12.0):** When you write/update an originals or ideas page that
references a person or company, the auto-link post-hook on `put_page`
automatically creates the link from the new page to that entity. You don't
need to call `gbrain link` manually. Timeline entries still need explicit calls.
```

---

## 4. enrich/SKILL.md

**位置：** 用v0.12.0版本替换`### Step7: Cross-reference`。

**为什么：** Step7以前主要是关于在相关实体页面之间创建链接。使用自动链接，这是自动的。Step7现在是关于内容更新，而不是链接创建。

旧版本（删除）：
```markdown
### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them
- Add back-links manually via `gbrain link` for any new entity references
```

新版本（粘贴）：
```markdown
### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them

**Note (v0.12.0):** Links between brain pages are auto-created on every
`put_page` call (auto-link post-hook). Step 7 focuses on content
cross-references (updating related pages' compiled truth with new signal
from this enrichment), not on creating links. Verify via the `auto_links`
field in the put_page response (`{ created, removed, errors }`).
Timeline entries still need explicit `gbrain timeline-add` calls.
```

---

## 应用所有四个差异后

1. **更新每个fork文件顶部的版本横幅：**
   ```
   # Based on gbrain v0.12.0 skills/<skill-name>, extended with <your-agent>-specific config
   ```

2. **运行v0.12.0回填**（这为您现有的brain填充图形）：
   ```bash
   gbrain post-upgrade
   ```
   v0.12.0发布将post-upgrade连接为自动调用`apply-migrations --yes`，它运行v0_12_0编排器（schema → config check → `extract links --source db` → `extract timeline --source db` → verify）。幂等；当没有待处理时成本低。

3. **验证自动链接工作：** 要求代理编写一个引用`[Some Person](people/some-person)`的测试页面。确认put_page响应包括`auto_links: { created: 1, removed: 0, errors: 0 }`。

4. **验证图形遍历工作：**
   ```bash
   gbrain graph-query people/some-well-connected-person --depth 2
   ```
   应返回类型化边的缩进树。

---

## v0.12.2热修复（数据正确性，无skill编辑）

v0.12.2是Postgres数据正确性热修复。不需要更改forked skill文件 — skill合同未更改。但您确实需要运行迁移，并且您应该知道markdown解析中的一个行为更改：

### 1. 运行迁移（Postgres支持的brains）

```bash
gbrain upgrade
```

`v0_12_2`编排器自动运行`gbrain repair-jsonb`。它重写`pages.frontmatter`, `raw_data.data`, `ingest_log.pages_updated`, `files.metadata`和`page_versions.frontmatter`中`jsonb_typeof = 'string'`的行。幂等，安全地重新运行。PGLite brains无操作干净地。

升级后验证：

```bash
gbrain repair-jsonb --dry-run --json    # expect totalRepaired: 0
```

### 2. 恢复任何截断的wiki文章

如果您的brain在v0.12.2之前导入了wiki风格的markdown，某些页面被静默截断（正文中的任何独立`---`被视为时间线分隔符）。从源重新导入：

```bash
gbrain sync --full
```

新的`splitBody`正确地重建`compiled_truth`。

### 3. 了解未来的splitBody合同

`splitBody`现在需要显式时间线哨兵。识别的标记（优先级顺序）：

1. `<!-- timeline -->`（首选 — `serializeMarkdown`发出的内容）
2. `--- timeline ---`（装饰性分隔符）
3. `---`直接在`## Timeline`或`## History`标题之前（向后兼容）

正文文本中的裸`---`现在是markdown水平规则，而不是时间线分隔符。如果您的代理使用裸`---`分隔符编写页面，请迁移到`<!-- timeline -->` — `serializeMarkdown`帮助程序已经这样做。

### 4. Wiki子类型现在自动类型化

`inferType`现在自动检测五个额外的目录模式作为它们自己的页面类型（以前它们都默认为`concept`）：

| 路径模式           | 新类型       |
|------------------------|----------------|
| `/wiki/analysis/`      | `analysis`     |
| `/wiki/guides/`        | `guide`        |
| `/wiki/hardware/`      | `hardware`     |
| `/wiki/architecture/`  | `architecture` |
| `/writing/`            | `writing`      |

如果您的skills或查询按`type=concept`过滤并期望该存储桶中的wiki内容，请更新它们以包含新类型。

---

## v0.13.0 — Frontmatter关系索引

**裁决：大多数skills不需要操作。** v0.13将YAML frontmatter字段投影到图形中作为类型化边。摄取API未更改 — 继续使用您今天使用的frontmatter调用`put_page`；图形在后台自动填充。

如果您想使用新的`auto_links.unresolved`响应字段，三个skills会获得一个可选的新阶段。没有这个，无法解析的frontmatter名称将静默跳过（与v0.12行为相同）。

### 1. meeting-ingestion/SKILL.md（可选）

**位置：** 在"Phase3: Write Meeting Page"之后添加新部分：

```markdown
### Phase3.5: Check for unresolved attendees (v0.13+)

After `put_page`, inspect `response.auto_links.unresolved` — an array of frontmatter
references that did not resolve to existing pages. For meetings, this usually means
attendees you haven't created a person page for yet.

If `unresolved.length > 0`:
- Option 1 (create pages now): trigger an enrichment pass to build the missing people pages.
- Option 2 (defer): log the unresolved names to the enrichment queue for later.
- Option 3 (accept the gap): the attendee edge will not be created until a page exists.
  Re-running `gbrain extract links --source db --include-frontmatter` after creating
  the page fills in the missing edges.
```

### 2. enrich/SKILL.md（可选）

**位置：** 添加到enrichment触发器列表。

```markdown
### Drain unresolved frontmatter names (v0.13+)

If any `put_page` response includes `auto_links.unresolved` entries, the enrichment
tier should pick up those (field, name) pairs and try to create the missing entity
pages. Example flow:

1. signal-detector captures a meeting with `attendees: [Alice Known, Unknown Person]`
2. put_page returns `auto_links.unresolved = [{field: 'attendees', name: 'Unknown Person'}]`
3. enrichment tier consumes `Unknown Person` → web search → creates `people/unknown-person.md`
4. The next put_page (or a backfill run) wires up the `attended` edge automatically
```

### 3. idea-ingest/SKILL.md（可选）

**位置：** 与meeting-ingestion相同的模式 — 在`put_page`之后检查`auto_links.unresolved`，将名称路由到enrichment。

### 未更改的skills（不需要差异）

- **brain-ops/SKILL.md** — 自动链接机制是内部的；写入路径保持不变。
- **signal-detector/SKILL.md** — 信号捕获路径未更改。
- **query/SKILL.md** — `traverse_graph`现在自动返回更丰富的结果。
- **daily-task-manager/SKILL.md**, **briefing/SKILL.md**, **citation-fixer/SKILL.md**, **media-ingest/SKILL.md** — 未更改。

### 您可以在图形查询中过滤的新边类型

v0.13边携带新的`link_type`值。如果您的fork具有按类型过滤的图形查询skills，那么现在可以使用这些：

- `works_at` (person → company) — 来自`company:`, `companies:`, 或`key_people:`
- `founded` (person → company) — 来自`founded:`
- `invested_in` (investor → deal/company) — 来自`investors:`或`lead:`
- `led_round` (lead → deal) — 来自`lead:`
- `yc_partner` (partner → company) — 来自`partner:`
- `attended` (person → meeting) — 来自`attendees:`
- `discussed_in` (source → page) — 来自`sources:`
- `source` (page → source) — 来自`source:`
- `related_to` (page → target) — 来自`related:`或`see_also:`

### 迁移时机

`gbrain upgrade`在46K页面brain上需要2-5分钟（一次性）。通过`gbrain post-upgrade`在进程外运行。如果您的代理在升级期间持有DB连接，请在之后重新连接；否则继续服务。

### v0.13中**不**进行类型规范化

具有`link_type='attendee'`或`link_type='mention'`的遗留行与新的`'attended'` / `'mentions'`行共存。您对旧类型名称的查询继续工作。v0.14中的单独选择性加入`gbrain normalize-types`命令处理重命名。

## v0.14.0 shell作业（可选采用，无skill编辑）

向Minions添加`shell`作业类型，以便确定性cron脚本（API获取，令牌刷新，抓取 + 写入）从LLM网关移开。每次触发零个令牌。典型规模下约60%网关CPU余量。功能**默认关闭**，现有安装保持与以前完全相同的方式运行。没有任何损坏。

要采用，请遵循`skills/migrations/v0.14.0.md`。简短版本：

1. 在工作进程上设置`GBRAIN_ALLOW_SHELL_JOBS=1`，然后`gbrain jobs work`（Postgres）。在PGLite上，每个crontab调用使用`--follow`进行内联执行；没有持久工作器。
2. 对主机的每个cron条目进行分类：需要LLM（保留在网关上）vs确定性（shell候选）。典型拆分：
   - **确定性 → shell：** `ycli-token-refresh`, `x-oauth2-refresh`, `x-garrytan-unified`, `calendar-sync-to-brain`, `github-pulse`, `frameio-scan`, `flight-tracker`, `x-raw-json-backfill`.
   - **需要LLM → 保留：** `social-radar`, `content-ideas`, `adversary-vacuum`, `ea-inbox-sweep`, `morning-briefing`, `brain-maintenance`.
3. 对于每个确定性cron，重写为：
   ```cron
   3 13,16,19,22,1,4,7,10 * * * \
     gbrain jobs submit shell \
       --params '{"cmd":"node scripts/your-script.mjs","cwd":"/data/.openclaw/workspace"}' \
       --max-attempts 3 --timeout-ms 300000
   ```
4. 观察`gbrain jobs get <id>`每次触发的exit_code / stdout_tail / stderr_tail。在批准下一批之前与迁移前行为进行比较。

**不需要skill编辑。** 处理程序在工作器端运行；skill文件不会更改。如果您的主机通过插件合同（v0.11.0）公开自定义处理程序，它们的工作方式仍相同。

铁律：**永远不要自动重写操作员的crontab。** 每次重写都是每cron，人工批准的，带有差异。如果您以后想要自动化，即将推出的`gbrain crontab-to-minions <file>`帮助程序在TODOS中是P1。

---

## v0.16.0：持久代理运行时

v0.15发布`gbrain agent run` / `gbrain agent logs`，Minions中的新`subagent`处理程序类型，以及用于主机仓库subagent defs的插件合同。现有skills都不需要手术。下游代理的问题是*如何*采用新的运行时，而不是如何围绕重大更改进行修补。

### 1. 使用Anthropic密钥运行工作器

subagent处理程序（`subagent`和`subagent_aggregator`）始终在工作器上注册。没有单独的选择加入标志 — `ANTHROPIC_API_KEY`是自然成本门（没有密钥，SDK调用在第一轮失败），并且谁可以提交已经受到保护（`PROTECTED_JOB_NAMES` + trusted-submit：MCP调用者获得`permission_denied`；只有`gbrain agent run`可以插入这些行）。

```bash
ANTHROPIC_API_KEY=sk-ant-... gbrain jobs work
```

工作器启动打印：

```
[minion worker] subagent handlers enabled
```

### 2. 将您的subagents作为插件发布（OpenClaw + 类似）

将您的自定义subagent定义从gbrain fork移到您自己的仓库中作为插件。具体来说：

```
~/<your-agent>/gbrain-plugin/
├── gbrain.plugin.json
└── subagents/
    ├── meeting-ingestion.md
    ├── signal-detector.md
    └── daily-task-prep.md
```

`gbrain.plugin.json`：

```json
{
  "name": "your-openclaw",
  "version": "2026.4.20",
  "plugin_version": "gbrain-plugin-v1"
}
```

每个`subagents/*.md`是纯文本代理定义 — YAML frontmatter + body-as-system-prompt。识别的frontmatter字段：`name`, `model`, `max_turns`, `allowed_tools`（必须是派生brain-tool注册表的子集）。

打开它：

```bash
export GBRAIN_PLUGIN_PATH="$HOME/<your-agent>/gbrain-plugin"
```

工作器启动为每个插件打印`[plugin-loader] loaded '<name>' v<ver> (N subagents)`；任何拒绝（错误清单，未知工具`allowed_tools`，版本不匹配）在启动时显示为响亮的警告，而不是静默调度时间失败。参见`docs/guides/plugin-authors.md`获取完整合同。

### 3. 用持久的替换短暂subagent运行

如果您的代理当前为应该 survvive崩溃，睡眠或工作器重启的工作生成短暂subagents（OpenClaw `Agent()`，临时Anthropic API调用等），请将它们迁移到`gbrain agent run`。持久性是免费的：

```bash
gbrain agent run "analyze my last 50 journal pages for recurring themes" \
  --subagent-def analyzer --fanout-manifest manifests/journal-pages.json
```

每一轮都持久化到`subagent_messages`，每个工具调用都是两阶段分类帐，并且`gbrain agent logs <job>`显示它死在哪里 + 最后一个成功调用返回了什么。不再有"因为会话上下文蒸发而从头开始重新运行"。

### 4. 来自subagents的`put_page`在代理命名空间下写入

如果您采用了v0.15 subagent运行时，请注意源自subagent工具调度的`put_page`调用必须目标`wiki/agents/<subagent_id>/...`。显示给模型的模式在第一次尝试时强制执行此操作；服务器端fail-closed检查拒绝其他任何内容。这**不会**影响您的skill文件，CLI put_page调用或MCP put_page — 只有LLM循环内的工具调度写入。

聚合输出（最终的"这是所有N个子项发现的内容" brain页面）通过单独的受信任CLI路径，而不是通过subagent工具调用，因此它可以写入您想要的任何位置。

铁律：**永远不要授予代理超出其命名空间的写入权限**。服务器端检查存在是因为调度程序错误发生；将其视为深度防御，而不是主要边界。

---

## v0.22.4 — frontmatter-guard采用

### 1. 停止手动滚动frontmatter验证器

如果您的fork具有直接调用`js-yaml`来验证brain页面frontmatter的脚本，请将它们替换为`gbrain frontmatter validate`调用。CLI涵盖七个规范错误类，并发布跨版本稳定的`--json`信封。

```diff
- # Custom validator script
- node scripts/validate-frontmatter.mjs <path>
+ gbrain frontmatter validate <path> --json
```

对于需要在另一个脚本中使用验证器的消费者，从gbrain的`markdown`导出导入，而不是复制逻辑：

```ts
import { parseMarkdown } from 'gbrain/markdown';

const parsed = parseMarkdown(content, filePath, { validate: true, expectedSlug });
for (const err of parsed.errors ?? []) {
  // err.code: MISSING_OPEN | MISSING_CLOSE | YAML_PARSE | SLUG_MISMATCH |
  //           NULL_BYTES | NESTED_QUOTES | EMPTY_FRONTMATTER
}
```

### 2. 删除对`lib/brain-writer.mjs`的任何引用

如果您的fork的skills或脚本引用了期望的`lib/brain-writer.mjs`（它从未发布 — 规范在PR #392中，从未落地），请将那些引用替换为gbrain CLI。`frontmatter-guard` skill位于`skills/frontmatter-guard/SKILL.md`并指向`gbrain frontmatter validate` / `audit` / `install-hook`。

### 3. 将doctor子检查连接到您的健康管道

`gbrain doctor`现在自动报告`frontmatter_integrity`。如果您的fork具有自定义健康管道（例如关于brain健康的每日Slack帖子），请从`gbrain doctor --json`中提取并呈现`frontmatter_integrity`行计数。

### 4. （可选）在brain仓库上安装预提交钩子

对于由git支持的源，v0.22.4 install-hook帮助程序放置一个预提交脚本，阻止具有格式错误的frontmatter的提交：

```bash
gbrain frontmatter install-hook
```

如果您的brain不是git仓库，或者您的下游代理已经在写入时强制执行验证，请跳过此操作。参见`docs/integrations/pre-commit.md`获取完整配方。

### 5. 迁移ergonomics — 读取pending-host-work.jsonl

在`gbrain apply-migrations --yes`运行v0.22.4审计之后，您的代理应该读取`~/.gbrain/migrations/pending-host-work.jsonl`（过滤到`migration === "0.22.4"`）并遍历每个条目的`command`字段。每个条目指向每源`gbrain frontmatter validate <source_path> --fix`命令 — 向用户呈现计数，获得明确同意，然后运行。

迁移是**仅审计**。它永远不会在`apply-migrations`期间变异brain内容。您的代理在用户同意的情况下运行修复命令。

---

## 未来版本

当gbrain发布新版本时，本文将使用该系统版本的差异化进行更新。每个新版本附加一个部分；旧部分保留，以便您可以一次赶上多个版本。

要检查您的fork缺少什么：
```bash
diff <(grep -A3 "Based on gbrain" ~/<your-fork>/skills/brain-ops/SKILL.md) \
     <(grep "v[0-9]" ~/gbrain/skills/migrations/ | tail -3)
```

## v0.36.5.0 — 用于调用`gbrain` CLI的shell作业的自由格式秘密继承

**更改。** Shell作业参数获得新的`inherit:`字段。在其上传递任何snake_case配置密钥名称；工作器在子生成时从其`loadConfig()`解析值，并将其注入子env。名称落在行中；值永远不会从`inherit:`持久化。验证在**预入队**时在两种提交路径（CLI + `submit_job`操作）中运行，因此格式错误的负载永远不会落在`minion_jobs.data`中。

**为什么。** 在v0.36.5.0之前，想要从shell作业调用`gbrain`的代理必须要么将`database_url`写入`~/.gbrain/config.json`明文，要么按作业传递`env: { GBRAIN_DATABASE_URL: "..." }`。两者都在某处留下明文秘密 — 磁盘或DB行。`inherit:`将名称保留在行中，并在生成时解析值。

**您的代理可以做什么。** `inherit:`是自由格式。传递任何配置密钥：

```jsonc
{
  "cmd": "gbrain sync --skip-failed && gbrain embed --stale",
  "cwd": "/data/gbrain",
  "inherit": ["database_url", "anthropic_api_key", "voyage_api_key"]
}
```

子项中的env密钥名称是通过将配置密钥大写派生的：`database_url` → `GBRAIN_DATABASE_URL`, `anthropic_api_key` → `ANTHROPIC_API_KEY`, `voyage_api_key` → `VOYAGE_API_KEY`等。验证器**不**监督您继承哪些配置密钥 — 代理与工作器处于相同的uid，因此这是代理的调用。

**您仍然可以使用`env:`。** v0.36.5.0不禁止`env:{ ANYTHING }`。如果您有理由将值放在行明文中（非秘密关联令牌，或者您知道可以持久化的秘密），请通过`env:`传递它。当您希望值离开行时，首选`inherit:`。

**工作器设置**（一次性，每主机）：

- `gbrain config set database_url postgresql://...`（或您想要用于继承的任何其他密钥）
- 或将密钥直接放在`~/.gbrain/config.json`中
- 或在工作器进程上设置`GBRAIN_DATABASE_URL` / `DATABASE_URL` / 每提供者env。

如果工作器无法解析请求的名称，验证器在提交时快速失败，并带有`gbrain config set <X>`提示。不再有提交后几分钟在子stderr中静默"无数据库URL"失败。

**也是新的。** `gbrain doctor`检查`home_dir_in_worktree`警告如果`~/.gbrain/`位于git工作树内。追溯性`~/.gbrain/.gitignore`（单行`*`）现在由每个`saveConfig()`调用和`gbrain post-upgrade`放置，因此现有用户在重新运行`gbrain init`时获得覆盖。诚实范围：`.gitignore`涵盖临时`git add`但不涵盖已跟踪的文件，屏幕截图，备份或`git add -f`。

**策略框架。** 对于代理到gbrain调用，新的规范指南是`docs/guides/agent-to-gbrain.md`。两个明显的表面：通过OAuth用于具有MCP等效项的操作的HTTP MCP（`search`, `query`, `put_page`等），以及用于`localOnly`管理操作的shell作业 + `inherit:`（`sync`, `embed`, `dream`, `doctor`等）。不是回退层次结构 — 按操作选择。

**要处理的错误**（您的代理提交shell作业；清楚地呈现这些）：

| 错误 | 含义 | 代理操作 |
|---|---|---|
| `shell: inherit must be an array of config-key names` | `inherit`不是数组。 | 传递`"inherit": ["database_url", ...]`。 |
| `shell: inherit entries must be non-empty strings` | 元素为空，非字符串或null。 | 使用snake_case配置密钥名称。 |
| `shell: inherit name "<X>" must match [a-z][a-z0-9_]*` | 名称未通过snake_case正则表达式（大写，前导下划线等）。 | 按原样使用配置密钥 — `database_url`，而不是`DATABASE_URL`。 |
| `shell: inherit requested "<X>" but worker has no <X> configured` | 工作器无法从其`loadConfig()`解析名称。 | 在工作器主机上运行`gbrain config set <X> <value>`。 |
