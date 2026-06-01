# GBrain 安装验证运行手册

在安装后运行这些检查以确认 GBrain 的每个部分都在工作。

每个检查都包括命令、预期输出以及如果失败该怎么办。

最重要的检查是 #4（实时同步）。"同步已运行"与"同步工作"不同。由于 pooler 错误而静默跳过页面的同步比没有同步更糟，因为你认为它正在工作。

---

## 1. 模式验证

**命令：**

```bash
gbrain doctor --json
```

**预期：** 所有检查都返回 `"ok"`：
- `connection`：已连接，N 个页面
- `pgvector`：扩展已安装
- `rls`：在所有表上启用
- `schema_version`：当前
- `embeddings`：覆盖率百分比

**如果失败：** doctor 输出包括每个检查的特定修复说明。请参见 `skills/setup/SKILL.md` 错误恢复表。

---

## 2. Skillpack 已加载

**检查：** 询问代理："什么是 brain-agent 循环？"

**预期：** 代理引用 GBRAIN_SKILLPACK.md 第 2 节并描述
读写周期：检测实体、读取 brain、用上下文响应、写入
brain、同步。

**如果失败：** 代理尚未加载 skillpack。从
安装粘贴运行步骤 6（读取 `docs/GBRAIN_SKILLPACK.md`）。

---

## 3. 自动更新已配置

**命令：**

```bash
gbrain check-update --json
```

**预期：** 返回带有 `current_version`、`latest_version`、
`update_available`（布尔值）的 JSON。cron `gbrain-update-check` 已注册。

**如果失败：** 从安装粘贴运行步骤 7。请参见 GBRAIN_SKILLPACK.md
第 17 节。

---

## 4. 实时同步实际工作

这是最重要的检查。三个部分。

### 4a. 覆盖率检查

比较数据库中的页面计数与仓库中可同步的文件计数：

```bash
gbrain stats
```

然后计算可同步文件：

```bash
find /data/brain -name '*.md' \
  -not -path '*/.*' \
  -not -path '*/.raw/*' \
  -not -path '*/ops/*' \
  -not -name 'README.md' \
  -not -name 'index.md' \
  -not -name 'schema.md' \
  -not -name 'log.md' \
  | wc -l
```

**预期：** `gbrain stats` 中的页面计数应该接近文件计数。

一些差异是正常的（自上次同步以来添加的文件），但如果页面计数
小于文件计数的一半，同步正在静默跳过页面。

**如果页面计数太低：** 头号原因是连接 pooler 错误。
检查你的 `DATABASE_URL`：
- 如果它包含 `pooler.supabase.com:6543`，验证它正在使用**会话模式**，
  而不是事务模式。
- 事务模式破坏 `engine.transaction()` 并导致 `.begin() is not a
  function` 错误。
- 修复：切换到会话模式 pooler 字符串，然后运行 `gbrain sync --full`
  以重新导入所有内容。

### 4b. 嵌入检查

```bash
gbrain stats
```

**预期：** 嵌入块计数应该接近（或接近）总块计数。

**如果嵌入比总数低得多：**

```bash
gbrain embed --stale
```

如果 `OPENAI_API_KEY` 未设置，则无法生成嵌入。关键字搜索
在没有嵌入的情况下仍然有效，但混合/语义搜索不会。

### 4c. 端到端测试

这是真正的测试。编辑 brain 页面，推送，搜索。

1. 在 brain 仓库中编辑页面（例如，更正人员页面上的事实）：
   ```bash
   # Example: fix a line in Gustaf's page
   cd /data/brain
   # Make a small edit to any .md file
   git add -A && git commit -m "test: verify live sync" && git push
   ```

2. 等待下一个同步周期（cron 间隔或 `--watch` 轮询）。

3. 搜索更正后的文本：

   ```bash
   gbrain search "<text from the correction>"
   ```

**预期：** 搜索返回**更正后的**文本，而不是旧版本。

**如果它返回旧文本：** 同步静默失败。检查：
- 同步 cron 是否已注册并正在运行？
- `gbrain sync --watch` 是否还活着（如果使用的是 watch 模式）？
- 运行 `gbrain config get sync.last_run` 以查看同步最后运行的时间。
- 手动运行 `gbrain sync --repo /data/brain` 并检查是否有错误。
- 如果你看到 `.begin() is not a function`，修复 pooler（参见上面的 4a）。

---

## 5. 嵌入覆盖率

**命令：**

```bash
gbrain stats
```

**预期：** 嵌入块计数匹配（或接近）总块计数。

**如果为零或非常低：** `OPENAI_API_KEY` 可能丢失或无效。检查：

```bash
echo $OPENAI_API_KEY | head -c 10
```

如果为空，请设置密钥。然后：

```bash
gbrain embed --stale
```

---

## 6. Brain-First 查找协议

**检查：** 询问代理关于 brain 中存在的人员或概念。

**预期：** 代理首先使用 `gbrain search` 或 `gbrain query`，而不是 grep
或外部 API。响应包括具有来源归属的 brain 来源上下文。

**如果失败：** brain-first 查找协议未注入代理的
系统上下文。请参见 `skills/setup/SKILL.md` D 阶段。

---

## 7. 知识图已连接

v0.12.0 图层需要为现有的 brain 填充。新写入是
自动链接的，但历史页面需要一次性回填。

**命令：**

```bash
gbrain stats | grep -E 'links|timeline'
```

**预期：** `links` 和 `timeline_entries` 都是非零（假设 brain
具有带有实体引用和注明日期的 markdown 的内容）。

**如果它在具有导入内容的 brain 上为零：** 运行回填。

```bash
gbrain extract links --source db --dry-run | head -5    # preview
gbrain extract links --source db                         # commit
gbrain extract timeline --source db
gbrain stats                                             # confirm > 0
```

**奖励检查** — 图遍历工作：

```bash
# Pick any well-connected slug from your brain
gbrain graph-query people/<some-person-slug> --depth 2
```

**预期：** 类型化边的缩进树（`--attended-->`, `--works_at-->`, 等）。
如果 slug 没有入站或出站链接，请尝试不同的链接，或再次运行 extract
。

**如果 extract 没有找到任何内容：** 你的页面可能没有使用实体引用语法。The
提取器匹配 `[Name](people/slug)`、`[Name](../people/slug.md)` 和裸
`people/slug` 引用。如果你的 brain 使用不同的格式，自动链接
启发式不会找到它们 — 用示例页面提交 issue。

---

## 8. JSONB 前置事务完整性 (v0.12.2)

在 v0.12.2 之前创建的 Postgres 支持的 brain 具有双重编码的 JSONB 列
（`frontmatter->>'key'` 返回 NULL，GIN 索引是无用的）。`gbrain upgrade`
通过 `v0_12_2`  orchestrator 自动运行 `gbrain repair-jsonb`。
验证修复成功。

**命令：**

```bash
gbrain repair-jsonb --dry-run --json
```

**预期：** 所有 5 个列（`pages.frontmatter`、
`raw_data.data`、`ingest_log.pages_updated`、`files.metadata`、
`page_versions.frontmatter`）的 `totalRepaired: 0`。零计数意味着每一行都是正确类型的
JSON 对象，而不是字符串编码的 JSON。

**如果计数 > 0：** 修复未运行或被中断。重新运行
而不使用 `--dry-run`：

```bash
gbrain repair-jsonb
```

幂等。PGLite brain 始终报告 0（不受原始错误影响）。

**奖励检查** — 前置事务键控查询实际解析：

```bash
gbrain call list_pages '{"frontmatterKey": "type", "frontmatterValue": "person"}'
```

如果这在具有人员页面的 brain 上返回行，则 JSONB 路径是健康的。

---

## 快速验证（一次传递中的所有检查）

```bash
# 1. Schema
gbrain doctor --json

# 2. Sync recency
gbrain config get sync.last_run

# 3. Page count + embed coverage
gbrain stats

# 4. Search works
gbrain search "test query from your brain content"

# 5. Catch any unembedded chunks
gbrain embed --stale

# 6. Auto-update
gbrain check-update --json

# 7. Knowledge graph populated (links + timeline > 0)
gbrain stats | grep -E 'links|timeline'

# 8. JSONB integrity (v0.12.2 — Postgres only, PGLite always 0)
gbrain repair-jsonb --dry-run --json
```

如果所有八个都成功返回，则安装是健康的。对于完整的
端到端同步测试 (4c)，推送真实更改并验证它出现在搜索中。
