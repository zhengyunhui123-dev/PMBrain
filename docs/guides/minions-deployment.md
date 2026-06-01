# Minions Worker 部署指南

保持 `gbrain jobs work` 在崩溃、重新启动和 Postgres
连接故障时运行。为 agents 编写，以便逐行执行。

## 问题

持久 worker 可能会因以下原因静默地死掉：

- 数据库连接断开（Supabase/Postgres 维护或网络故障）。
- 锁更新失败 → 失速检测器最终死信作业。
- Bun 进程崩溃，没有自动重启。
- 内部事件循环死亡（PID 活着，worker 循环停止）。

当 worker 死掉时，提交的作业会永远停留在 `waiting` 中。
规范的答案是 `gbrain jobs supervisor` — 一个一级 CLI，它
生成 `gbrain jobs work` 作为子级，并在崩溃时自动重启它。

## Worker 监督

### 规范模式

`gbrain jobs supervisor` 是 `gbrain jobs work` 的自动重启包装器。它写入 PID 文件，在崩溃时以指数退避（1 秒 → 60 秒上限）重启 worker，
将生命周期事件发出到审计文件，并在 SIGTERM 上正常排出（35 秒 worker 排出窗口
在 SIGKILL 之前）。退出代码已记录，以便 agents 可以对它们进行分支。

**典型命令：**

```bash
# 在前台启动（阻塞；Ctrl-C 停止）。
gbrain jobs supervisor --concurrency 4

# 分离启动 — 在 stdout 上返回 {event："started"、supervisor_pid：…} 然后分离。
gbrain jobs supervisor start --detach --json

# 检查活跃度，无需读取日志文件。
gbrain jobs supervisor status --json

# 正常停止（SIGTERM + 排出等待 + SIGKILL 回退）。
gbrain jobs supervisor stop
```

**退出代码：**

| 代码 | 含义 |
|---|---|
| 0 | 干净关闭（收到 SIGTERM/SIGINT，worker 已排出） |
| 1 | 超出最大崩溃次数（worker 不断死亡） |
| 2 | 另一个 supervisor 持有 PID 锁定 |
| 3 | PID 文件不可写（权限 / 路径错误） |

看到 exit=2 的 agent 可以安全地将其视为 "一个已在运行"；
exit=1 应该分页给人类。

### 何时使用哪个 supervisor？

Supervisor 解决进程内崩溃恢复。平台级
监督（systemd、Fly、Render）处理主机级故障。你
通常想要两者。

| 环境 | 建议 |
|---|---|
| **容器（Fly / Railway / Render / Heroku）** | `gbrain jobs supervisor` 作为 PID 1 运行。平台在 OOM / 主机丢失时重新启动容器；supervisor 在崩溃时重新启动 worker。请参阅 [Fly.io](#flyio) / [Render / Railway / Heroku](#render--railway--heroku)。 |
| **带有 systemd 的 Linux VM** | 推荐两层：systemd 监督 `gbrain jobs supervisor`，而 supervisor 又监督 `gbrain jobs work`。为你提供重新启动时自动重启（systemd）加上快速崩溃恢复（supervisor）。请参阅 [systemd](#systemd)。 |
| **开发笔记本电脑 / macOS** | 终端中的 `gbrain jobs supervisor`。Ctrl-C 停止它。不需要系统级设置。 |

### 本指南中使用的变量

在复制粘贴任何代码段之前替换这些一次。

| 变量 | 含义 | 典型值 |
|---|---|---|
| `$GBRAIN_BIN` | `gbrain` 二进制文件的绝对路径 | `$(command -v gbrain)` — 通常为 `/usr/local/bin/gbrain` 或 `~/.bun/bin/gbrain` |
| `$GBRAIN_WORKER_USER` | 拥有 worker 进程的 OS 用户 | 运行 `gbrain init` 的相同用户；永远不要 `root` |
| `$GBRAIN_WORKSPACE` | 此部署提交的 shell 作业的 `cwd` | 绝对路径，例如 `/srv/my-brain` |
| `$GBRAIN_ENV_FILE` | systemd / shell 获取的密钥文件 | `/etc/gbrain.env`（模式 600） |

### 先决条件

在任何部署步骤之前运行这些。

```bash
# 1. gbrain 在 PATH 上，并解析为绝对位置。
command -v gbrain || { echo "gbrain 不在 PATH 上。安装，然后重试。"; exit 1; }

# 2. DATABASE_URL 指向可访问的 Postgres。
#    （Supervisor 是仅 Postgres 的。PGLite 的独占文件锁会阻止
#    单独 worker 进程。如果 `config.engine === 'pglite'` CLI 拒绝
#    并显示明确的错误。）
gbrain doctor --fast --json | jq '.checks[] | select(.name=="db_connectivity")'

# 3. Schema 是最新的。如果 version=0 或 status=="fail"：
#    gbrain apply-migrations --yes
gbrain doctor --fast --json | jq '.checks[] | select(.name=="schema_version")'

# 4. 如果你计划提交 `shell` 作业，请传递 --allow-shell-jobs 到
#    supervisor（或在启动之前导出 GBRAIN_ALLOW_SHELL_JOBS=1）。
#    没有该标志，worker 启动时会禁用 shell 处理程序。
```

## Agent 用法（OpenClaw / Hermes / Cursor / Codex）

Agent 可以在没有 shell 考古学的情况下驱动三命令模式：

```bash
# 启动（在 stdout 上返回 PID + pid_file 作为 JSON，然后分离）
gbrain jobs supervisor start --detach --json
# → {"event":"started","supervisor_pid":1234,"worker_pid":1235,"pid_file":"/Users/you/.gbrain/supervisor.pid"}

# 检查运行状况（机器可解析的 JSON，没有日志抓取）
gbrain jobs supervisor status --json
# → {"running":true,"supervisor_pid":1234,"last_start":"2026-04-23T15:30:22Z","crashes_24h":0, ...}

# 停止干净（SIGTERM + 35 秒排出 + SIGKILL 回退）
gbrain jobs supervisor stop
```

每个生命周期事件（生成、崩溃、退避、运行状况警告、最大崩溃、
关闭）也会写入 `${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl`
以供历史检查。`gbrain doctor` 读取该文件并在其运行状况报告中显示
`supervisor` 检查。

## 部署：systemd

用于具有 shell 访问权限的长运行 Linux VM。

```bash
# 如果它不存在，请创建 worker 用户。
sudo useradd --system --home "$GBRAIN_WORKSPACE" --shell /usr/sbin/nologin gbrain \
  2>/dev/null || true
sudo mkdir -p "$GBRAIN_WORKSPACE" && sudo chown gbrain:gbrain "$GBRAIN_WORKSPACE"

# 安装 env 文件（密钥保留在单元文件之外）。
sudo install -m 600 -o gbrain -g gbrain \
  docs/guides/minions-deployment-snippets/gbrain.env.example /etc/gbrain.env
sudoedit /etc/gbrain.env
# 填写 DATABASE_URL，可选 GBRAIN_ALLOW_SHELL_JOBS=1。

# 安装单元文件，将 /srv/gbrain → 你的工作空间路径。
sudo install -m 644 docs/guides/minions-deployment-snippets/systemd.service \
  /etc/systemd/system/gbrain-worker.service
sudo sed -i "s|/srv/gbrain|$GBRAIN_WORKSPACE|g" \
  /etc/systemd/system/gbrain-worker.service

sudo systemctl daemon-reload
sudo systemctl enable --now gbrain-worker
sudo systemctl status gbrain-worker
journalctl -u gbrain-worker -n 50
```

发布的单元文件调用 `gbrain jobs supervisor`（不是 `gbrain jobs work`
直接），以便你获得两层监督：systemd 在主机重新启动时重新启动 supervisor，
supervisor 在进程内崩溃时重新启动 worker。

`Restart=always` + `RestartSec=10s` 处理 supervisor 级恢复。
该单元作为无特权的 `gbrain` 运行，具有 `PrivateTmp`、`ProtectSystem=strict`，
并且 `ReadWritePaths=$GBRAIN_WORKSPACE,$HOME/.gbrain`（用于 PID 文件和
审计日志）。`LimitNOFILE=65535` 涵盖了 Bun + Postgres 池 + 并发
LLM subagent 调用，而不会达到默认 1024 上限。

## 部署：Fly.io

```bash
# 将 [processes] 块从 fly.toml.partial 合并到你的 fly.toml。
cat docs/guides/minions-deployment-snippets/fly.toml.partial >> fly.toml
# 审查 + 根据需要编辑。

# 设置密钥（Fly 在崩溃时处理重新启动）。
fly secrets set DATABASE_URL='postgres://…' GBRAIN_ALLOW_SHELL_JOBS=1
```

`[processes]` 块将 `gbrain jobs supervisor` 作为 PID 1 运行。Fly
在主机发生故障时重新启动容器；supervisor 在
进程内崩溃时重新启动 worker。

## 部署：Render / Railway / Heroku

将 [`Procfile`](./minions-deployment-snippets/Procfile) 放在仓库
根目录。发布的 Procfile 调用 `gbrain jobs supervisor`。设置
`DATABASE_URL` + 可选 `GBRAIN_ALLOW_SHELL_JOBS=1` 通过平台的
env UI 或 CLI。

## 部署：内联 `--follow`（没有持久 worker）

用于固定计划上的短确定性脚本，你不需要
在运行之间使用持久 worker。每个 cron 运行都会带来自己的临时
worker。`--follow` 在队列上启动一个，并阻塞直到
刚刚提交的作业到达终端状态（`completed` / `failed` /
`dead` / `cancelled`）。每个作业 2-3 秒启动开销；与
计划工作的持续时间相比可以忽略不计。

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --queue nightly-enrich \
  --params "{\"cmd\":\"$GBRAIN_BIN embed --stale\",\"cwd\":\"$GBRAIN_WORKSPACE\"}" \
  --follow \
  --timeout-ms 600000
```

将 `gbrain embed --stale` 替换为你正在
调度的任何 `gbrain` 子命令（`sync`、`extract`、`orphans`、`doctor`、
`check-backlinks`、`lint`、`autopilot`）。对于共享队列上的严格单作业语义，
使用专用的队列名称，如上面的 `nightly-enrich`。

## 从旧部署升级

### 从 `minion-watchdog.sh`（v0.20 之前）

此指南的早期版本提供了一个 68 行的 bash watchdog
（`minion-watchdog.sh`）。它已被 `gbrain jobs supervisor` 替换，
后者处理脚本执行的所有操作，加上原子 PID 锁定、
结构化审计事件、队列范围的运行状况检查和 SIGTERM 上的正常
排出。

**迁移：**

```bash
# 1. 停止并删除旧的 watchdog。
sudo kill $(head -n1 /tmp/gbrain-worker.pid) 2>/dev/null
sudo rm -f /usr/local/bin/minion-watchdog.sh /tmp/gbrain-worker.pid \
          /tmp/gbrain-worker.log
crontab -e   # 删除 "*/5 * * * * /usr/local/bin/minion-watchdog.sh" 行

# 2. 启动 supervisor（systemd 用户：从
#    docs/guides/minions-deployment-snippets/systemd.service 重新安装单元文件，该文件
#    现在调用 `gbrain jobs supervisor`）。
gbrain jobs supervisor start --detach --json
# 或：sudo systemctl restart gbrain-worker

# 3. 验证。
gbrain jobs supervisor status --json
gbrain doctor   # 'supervisor' 检查应报告 running=true
```

### Schema / 迁移 hygiene

无论你从哪个部署路径升级：

1. **在升级之前停止 worker。** `gbrain jobs supervisor stop`
   （或 `sudo systemctl stop gbrain-worker`）。跳过此步骤会
   冒有
   飞行中作业降落部分 schema 的风险。
2. **运行 `gbrain upgrade`。** 然后，如果
   `gbrain doctor` 将任何迁移报告为 `partial` 或 `pending`，则运行
   `gbrain apply-migrations --yes`。
3. **如果你运行 shell 作业：** 从 v0.14 开始，传递
   `--allow-shell-jobs` 到 supervisor（或将
   `GBRAIN_ALLOW_SHELL_JOBS=1` 保留在 `/etc/gbrain.env` 中）。提交者不
   需要该标志；仅 worker 需要。
4. **验证。** `gbrain doctor` 应报告零个 `pending` 或 `partial`
   迁移加上健康的 `supervisor` 检查。`gbrain jobs stats`
   应显示在升级前和升级后之间 `dead` 中没有不明原因的增长。

## 已知问题

### Supabase 连接断开

Worker 使用单个 Postgres 连接。如果 Supabase 断开它
（维护、连接限制、网络故障），锁更新会
静默失败。然后，失速检测器会在
`max_stalled` 未命中后死信该作业。

**使这更糟的当前默认值：**

- `lockDuration：30000`（30 秒）— 对于期间的
  连接故障来说太短了。
- `max_stalled：5`（schema 列默认值 — 请参阅 `src/schema.sql` 和
  `src/core/pglite-schema.ts`）。在死信之前有 5 次未命中的心跳。
- `stalledInterval：30000`（30 秒）— 检查过于激进。

**今天按作业调整。** `gbrain jobs submit` 接受 `--max-stalled N`、
`--backoff-type fixed|exponential`、`--backoff-delay <ms>`、
`--backoff-jitter 0..1` 和 `--timeout-ms N` 作为一级标志
（自 v0.13.1 起）。这些在提交时写入作业行 — 这就是
`handleStalled()` 读取的内容 — 因此按作业调整是今天的
真正旋钮。

### 不要将 `maxStalledCount` 传递给 `MinionWorker`

这是无操作的。失速检测器读取行的 `max_stalled` 列
（在提交时设置），而不是 `src/core/minions/worker.ts:74` 中的 worker 选项。
改为对每个作业使用 `gbrain jobs submit --max-stalled N`。

### 僵尸 shell 子级

当 Bun worker 硬崩溃时，来自 shell 作业的子进程可以
变成僵尸。Supervisor 的 SIGTERM → 35 秒排出 → SIGKILL 窗口
涵盖 shell 处理程序的 5 秒子级终止宽限（`KILL_GRACE_MS`）。对于
长时间运行的 shell 作业，更喜欢通过提交时使用 `--timeout-ms` 进行超时
而不是依赖硬终止。

## 冒烟测试

```bash
# Supervisor 还活着吗？
gbrain jobs supervisor status --json | jq .running

# 聚合队列运行状况。
gbrain jobs stats

# 当前失速的作业（仍然是 `active`，锁定的 lock_until，预重新排队）。
gbrain jobs list --status active --limit 10

# 死信作业。
gbrain jobs list --status dead --limit 10

# Shell 处理程序已注册？ （检查 supervisor 审计日志或 worker stderr。）
gbrain jobs supervisor status --json | jq '.worker_config.allow_shell_jobs'
```

## 卸载

**`gbrain jobs supervisor`**（前台或 `--detach`）：

```bash
gbrain jobs supervisor stop
```

**systemd：**

```bash
sudo systemctl disable --now gbrain-worker
sudo rm /etc/systemd/system/gbrain-worker.service /etc/gbrain.env
sudo systemctl daemon-reload
```

**Fly / Render / Railway：** 从 `fly.toml` 中删除 `worker` 进程
/ `Procfile` 并重新部署。通过 `fly secrets` 设置的密钥会
持久化，直到 `fly secrets unset`。

**内联 `--follow`：** 删除 cron 条目。无需清理其他内容 —
临时 workers 会随其作业退出。
