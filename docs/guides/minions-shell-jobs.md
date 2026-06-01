# Minions shell 作业 — 将确定性 crons 从网关移开

## 30 秒

```bash
# 运行你的第一个 shell 作业：
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --params '{"cmd":"echo hello","cwd":"/tmp"}' --follow
# → exit_code: 0, stdout_tail: "hello\n", duration_ms: 43
```

就是这样。你的 cron 脚本现在有一个家，具有重试、退避、DLQ 和
`gbrain jobs list` 可见性，而无需每个都引导完整的 LLM 会话。

**PGLite 用户：** `gbrain jobs work` 不会在 PGLite 上运行（独占文件
锁）。每个 crontab 调用都必须使用 `--follow` 进行内联执行。
Postgres 用户可以运行持久 worker；请参阅下面的配方。

---

## 为什么它存在

如果你的 agent 从 cron 运行确定性脚本（token 刷新、API 提取、
抓取 + 写入），则每个都会支付网关上完整 LLM 会话的成本。
同时触发 14 个会在 A 轮部署上将 CPU 固定在 100% 并阻塞
实时消息。这些脚本都不需要推理。它们需要一个 shell。

Shell 作业将它们移动到 Minions worker：每个 cron 一次确定性脚本执行，
零 LLM token，统一的可见性和重试。

---

## 安全模型（阅读此内容）

Shell exec 是一个大型爆破半径。我们发布了两个独立的门，都必须
通过：

1. **MCP 边界。** 当 `ctx.remote === true`（MCP 调用程序）时，`submit_job` 和 `{'name': 'shell'}` 被拒绝。独立于 env 标志。Remote
   agents 永远无法提交 shell 作业。`MinionQueue.add('shell', ...)` 具有
   它自己的保护程序，因此进程内处理程序无法以编程方式绕过此操作。
2. **Env 标志。** 仅当
   `GBRAIN_ALLOW_SHELL_JOBS=1` 设置在 worker 进程上时，worker 才会注册 shell 处理程序。默认值：关闭。你的
   agent 按主机选择加入。

**env 允许列表的作用和不作用。** Shell 作业使用最少的
env 运行：`PATH`、`HOME`、`USER`、`LANG`、`TZ`、`NODE_ENV`。你的密钥（如 `OPENAI_API_KEY`
和 `DATABASE_URL`）不会传递到子级。你可以通过 `env: { ... }` 选择加入其他密钥
（仅限非密钥值 — 请参阅下面的"密钥"），或通过
`inherit: ["database_url"]`（推荐用于密钥 — 名称仅在行中，
值在从 `gbrain config set` 生成时从 worker 的配置中解析）。这会阻止
偶然的 `$OPENAI_API_KEY` 插值在用户创作的脚本中。它**不会**
沙盒文件系统读取：shell 脚本可以 `cat ~/.env` 或 worker 进程可以读取的
任何文件。操作员选择一个安全的 `cwd`。那就是信任
边界。

**审计跟踪，不是取证保证。** 每次提交都会将 JSONL 行写入
`~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl`（ISO 周轮换；使用 `GBRAIN_AUDIT_DIR` 覆盖）。失败会记录到 stderr，但不会阻止提交，因此
磁盘已满的对手可以静默地禁用跟踪。善于"上周二这个 cron 提交了什么"，而不是
用于安全关键的取证。

**命令文本按原样记录。** 如果你在 `cmd` 中嵌入密钥，
（ `curl -H 'Authorization: Bearer ...'`），它会显示在审计文件中。将
密钥放在 `env:` 中而不是。

---

## 迁移 cron

### Postgres worker（推荐）

在一个终端上，启动持久 worker：

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work
```

重写 crontab 以提交 shell 作业（没有 `--follow`）：

```cron
# 之前（LLM 网关）：
#   OpenClaw cron：x-garrytan-unified

# 之后（Minions worker）：
3 13,16,19,22,1,4,7,10 * * * \
  gbrain jobs submit shell \
    --params '{"cmd":"node scripts/x-garrytan-daily.mjs","cwd":"/data/.openclaw/workspace"}' \
    --max-attempts 3 --timeout-ms 300000
```

Worker 在下次轮询时认领作业，运行它，在结果中记录 `exit_code` +
`stdout_tail` + `stderr_tail`。失败会根据
`--max-attempts` 和指数退避重试。

### PGLite（内联执行）

PGLite 不支持持久 worker 守护程序。每个 crontab 调用
使用 `--follow` 进行内联运行：

```cron
# 每个 cron 刻度生成一个短寿命的 worker，该 worker 内联运行作业。
3 13,16,19,22,1,4,7,10 * * * \
  GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
    --params '{"cmd":"node scripts/x-garrytan-daily.mjs","cwd":"/data/.openclaw/workspace"}' \
    --follow --timeout-ms 300000
```

注意：`--follow` 会阻塞 crontab 插槽，直到作业完成。如果 14 个 shell
cron 在同一分钟触发，并且每个都需要 30 秒，则它们会序列化通过
crontab 的生成限制。Postgres + 持久 worker 扩展得更好。

### 从 shell 作业调用 `gbrain` 本身 — 对 DATABASE_URL 使用 `inherit:` {#secrets}

一个常见的模式是提交运行 `gbrain` CLI 命令的 shell 作业：

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed && gbrain embed --stale",
  "cwd": "/data/brain",
  "inherit": ["database_url"]
}'
```

`inherit: ["database_url"]` 告诉 worker 从其自己的 `loadConfig()` 中查找 `database_url`（文件 + env 合并），并将值作为 `GBRAIN_DATABASE_URL` 注入到子级的环境中。`minion_jobs.data` 中的数据库行仅携带名称 — `inherit: ["database_url"]` — 永远不会携带值。请参阅
完整的验证规则和错误目录。

**为什么不直接将 URL 写入 `env:`？** v0.36.5.0 之前的调用者
写了如下内容：

```jsonc
// v0.36.5.0 之前：有效，但 URL 以明文形式持久化在 minion_jobs.data 中。
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/brain",
  "env": { "GBRAIN_DATABASE_URL": "postgresql://..." }
}
```

这会将 URL 以明文形式放在 `minion_jobs.data` 和 shell-audit
JSONL 中。任何具有 brain-DB 读取访问权限的人（或通过挂载的共享 brain）都会看到该 URL。从 v0.36.5.0 开始，这在入队前验证时被拒绝。错误消息将 `inherit: ["database_url"]` 命名为
替代方案。

**范围：** v0.36.5.0 `inherit:` 是**自由格式**。传递 worker 上的任何 snake_case
配置键名称 — `database_url`、`anthropic_api_key`、`openai_api_key`、
`voyage_api_key`、`groq_api_key`、`zeroentropy_api_key`，或你填入 `~/.gbrain/config.json` 的任何自定义字段。Agent 选择它需要的内容。

**输出侧泄漏（阅读此内容）。** `inherit:` 允许列表可防止
密钥登陆 JOB ROW INPUT 字段（`data.cmd`、`data.argv`、
`data.env`）。默认情况下，它**不会**清除输出字段 — 如果你的
脚本将密钥打印到 stdout 或 stderr（`echo "$GBRAIN_DATABASE_URL"`、
`psql "$GBRAIN_DATABASE_URL"` 在错误时回显 URL），则该值会
以明文形式落在 `result.stdout_tail` / `result.stderr_tail` / `error_text` 中，
并从那里进入 brain DB 行。

`redact_secrets: true` 选择启用输出侧清除。按作业设置
（或在 CLI 上传递 `--redact-secrets`）：

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/brain",
  "inherit": ["database_url"],
  "redact_secrets": true
}'

# 或，等效地：
gbrain jobs submit shell \
  --params '{"cmd":"gbrain sync --skip-failed","cwd":"/data/brain","inherit":["database_url"]}' \
  --redact-secrets
```

当 `redact_secrets: true` 时，worker 会将 `inherit:` 中的每个名称解析为
值，运行子级，然后将那些
值中的所有匹配项替换为 `stdout_tail` / `stderr_tail`（以及
从 `stderr_tail` 派生的 `error_text` 中）
`<REDACTED:name>` 在持久化之前。仅清除 `inherit:`-解析的值；
调用者提供的 `env:` 值不会（那些是"我同意此行中"
通道设计的）。

**启发式，不是完美的。** 清除程序使用文字字符串替换。在打印之前对密钥进行 base64 编码的
脚本，或逐个字符发出的脚本，将绕过清除程序。那些是
对抗性形状 — agent + 脚本位于相同的信任域中，因此此
层可防止偶然的 echo（常见情况），而不是故意的
过滤。

**编写处理密钥的 shell 作业的三个规则：**

- **更喜欢根本不 echo 密钥。** 即使使用 `redact_secrets`，较少的
  输出意味着如果清除程序遇到边缘情况未命中，则风险较低。
- **包装嘈杂的 CLI 工具以在错误时抑制 URL。** `psql --quiet`、
  `pg_dump --quiet`，或通过
  `2>&1 | sed 's|postgresql://[^@]*@|postgresql://REDACTED@|g'`。
- **失败后使用 `gbrain jobs get <id>` 进行检查。** 验证什么
  实际上持久化了。

### 使用 `argv` 提交（没有 shell 插值）

对于从 JSON 组装命令的编程调用程序，请使用 `argv` 而不是
`cmd`。没有 shell，没有注入表面：

```bash
gbrain jobs submit shell \
  --params '{"argv":["node","scripts/fetch.mjs","--date","2026-04-19"],"cwd":"/data"}' \
  --follow
```

---

## 调试失败作业

```bash
# 列出死信 shell 作业
gbrain jobs list --status dead

# 检查一个
gbrain jobs get 42
# → error_text、stacktrace、result.stdout_tail、result.stderr_tail

# 提交审计日志（操作员跟踪，不是取证）
cat ~/.gbrain/audit/shell-jobs-*.jsonl | jq '.'

# 首次失败模式：在没有 worker 上的 env 标志的情况下提交
gbrain jobs list --status waiting --name shell
# 如果行堆积在此处，则没有运行 GBRAIN_ALLOW_SHELL_JOBS=1 的 worker。
```

---

## 限制

- **文件系统读取不是沙盒的。** 请参阅上面的"安全模型"。不要
  将 `cwd` 指向充满密钥的目录。
- **审计日志是建议性的。** 磁盘已满或 EACCES 会静默禁用它。
- **取消延迟是锁定续期边界**（~7-15 秒，默认）。取消的
  子级会继续运行，直到下一个锁续期 tick 失败。
- **`--follow` 认领顺序** 是按 priority/created_at 的。如果在
  `--follow` 时另一个作业正在
  同一队列中等待，则该作业首先运行。
- **`cwd` 符号链接 TOCTOU。** 绝对路径检查不会在
  执行时防止指向其他位置的符号链接。操作员范围的关注点。

---

## 错误 {#errors}

| 错误 | 含义 | 修复 |
|---|---|---|
| `shell: specify exactly one of cmd or argv` | `cmd` 和 `argv` 是互斥的。两者都不在也是无效的。 | 选择一个。`cmd` 用于 shell 插值字符串；`argv` 用于结构化参数。 |
| `shell: cwd is required and must be an absolute path` | `cwd` 必须是以后斜杠开头的字符串。 | 在 `--params` 中将 `cwd` 设置为绝对路径。 |
| `shell: argv must be an array of strings` | `argv` 具有非字符串条目或不是数组。 | 传递 `argv: ["bin","arg1","arg2"]`。 |
| `shell: env values must all be strings` | `env` 具有数字/布尔值/对象值。 | 字符串化：`"env":{"COUNT":"3"}` 而不是 `"env":{"COUNT":3}`。 |
| `shell: inherit must be an array of config-key names` | `inherit` 不是数组。 | 传递 `"inherit": ["database_url", ...]`。 |
| `shell: inherit entries must be non-empty strings` | `inherit` 的元素为空、非字符串或 null。 | 使用 snake_case 配置键名称，如 `database_url`、`anthropic_api_key`。 |
| `shell: inherit name "<X>" must match [a-z][a-z0-9_]*` | 名称未通过 snake_case 正则表达式（大写、前导数字/下划线、特殊字符）。 | 逐字使用配置键名称 — `database_url`，而不是 `DATABASE_URL`。 |
| `shell: inherit requested "<X>" but worker has no <X> configured` | Worker 无法从 `loadConfig()` 解析请求的名称。 | 在 worker 主机上运行 `gbrain config set <X> <value>`，或检查 `~/.gbrain/config.json` 中的配置文件。 |
| `shell: redact_secrets must be a boolean if set` | 调用程序为 `redact_secrets` 传递了非布尔值。 | 传递 `true` 或 `false`（或省略）。CLI `--redact-secrets` 标志会自动设置它。 |
| `permission_denied: shell jobs cannot be submitted over MCP` | MCP 客户端尝试提交 shell 作业。按设计，仅 CLI。 | 从 CLI 或通过受信任的操作处理程序（`ctx.remote === false`）提交。 |
| `protected job name 'shell' requires CLI or operation-local submitter` | 调用程序在没有 `trusted` 选择加入的情况下调用了 `MinionQueue.add('shell', ...)`。 | 将 `{ allowProtectedSubmit: true }` 作为第 4 个参数传递。CLI 和 `submit_job` 会自动执行此操作。 |
| `aborted: timeout` / `aborted: cancel` / `aborted: shutdown` / `aborted: lock-lost` | Worker 的中止信号在 mid-execution 时触发。子级获得 SIGTERM、5 秒宽限，然后 SIGKILL。 | 预期：超时 / 用户取消 / 部署重新启动 / 失速。使用 `gbrain jobs get` 进行检查以查看哪个。 |
| `exit N: <stderr_tail_500>` | 脚本以非零退出。 | 在 `gbrain jobs get` 中读取 `stderr_tail`。 |
