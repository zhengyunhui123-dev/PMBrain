# Minions 修复 — 修复半迁移的安装

**tl;dr：** 在 v0.11.1+ 上，一切都应该自我修复。如果 Minions 是部分
设置的（没有 `~/.gbrain/preferences.json`，autopilot 仍在内联，cron 作业
仍在 `agentTurn` 上），请运行：

```bash
gbrain apply-migrations --yes
```

它是幂等的。在已经迁移的 v0.11.1 安装上，它是一个廉价的
无操作。

## 上下文

v0.11.0 发布了 Minions schema、队列和迁移 skill —
但迁移 skill 本身在升级时从未触发。`runPostUpgrade`
打印了功能宣传并停止了。v0.11.0 从未
公开发布；v0.11.1 是第一个公共 Minions 版本，并修复了
巨型错误（迁移在 `gbrain upgrade` 时自动触发，并通过
`postinstall` hook）。

如果你在 v0.11.1 之前的分支构建（例如，在 v0.11.1 标记之前运行
`minions-jobs` 分支），则 Minions 可能已安装
但未连接：schema 是 v7，但没有 `~/.gbrain/preferences.json`，
autopilot 仍在内联运行，cron 作业仍在调用 `agentTurn`。

本指南涵盖了两种路径：规范的 v0.11.1+ 修复，以及
没有 `apply-migrations` 的 v0.11.1 之前二进制文件的
停止缺口。

## 检测半迁移状态

```bash
gbrain doctor
```

如果安装是半迁移的，你将看到：

```
[FAIL] minions_migration: MINIONS HALF-INSTALLED (partial migration: 0.11.0). Run: gbrain apply-migrations --yes
```

或

```
[FAIL] minions_config: MINIONS HALF-INSTALLED (schema v7+ but no ~/.gbrain/preferences.json). Run: gbrain apply-migrations --yes
```

对于机器可读的报告（cron 友好）：

```bash
gbrain skillpack-check --quiet && echo healthy || echo needs_action
gbrain skillpack-check | jq -r '.actions[]'    # 打印要运行的确切命令
```

## 修复（v0.11.1 或更高版本）

```bash
gbrain apply-migrations --yes
```

读取 `~/.gbrain/migrations/completed.jsonl`，与 TS
迁移注册表进行比较，并运行任何挂起的内容。七个阶段：

```
A. Schema        gbrain init --migrate-only
B. Smoke         gbrain jobs smoke
C. Mode          prompt (or --yes default pain_triggered)
D. Prefs         write ~/.gbrain/preferences.json
E. Host          AGENTS.md marker injection + cron rewrites for gbrain
                  builtins; JSONL TODOs for host-specific handlers
F. Install       gbrain autopilot --install (env-aware)
G. Record        append completed.jsonl status:"complete"
```

如果阶段 E 发出主机特定处理程序（例如，你的 OpenClaw 的
~29 个非 gbrain crons）的 TODO，则迁移以 `status: "partial"` 完成。
你的主机 agent 使用 `skills/migrations/v0.11.0.md` +
`docs/guides/plugin-handlers.md` 来运送处理程序注册，然后重新运行
`gbrain apply-migrations --yes`。新
注册表可捕获的 cron 条目将被重写，并且 JSONL 行将标记
`status: "complete"`。

## 停止缺口（v0.11.1 之前的二进制文件，还没有 apply-migrations）

如果你被困在具有 `apply-migrations` 的
分支构建上：

```bash
curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/v0.11.1/scripts/fix-v0.11.0.sh | bash
```

此 bash 脚本执行 apply-migrations 从 shell 环境执行的操作：

1. `gbrain init --migrate-only` — schema v7。
2. `gbrain jobs smoke` — 验证 Minions 运行状况。
3. Prompt for `minion_mode`（非 TTY 上的默认 `pain_triggered`）。
4. 原子地写入 `~/.gbrain/preferences.json`。
5. 附加 `~/.gbrain/migrations/completed.jsonl`，其 `status: "partial"`
   和 `apply_migrations_pending: true`。该部分记录是
   用于在用户升级后由 v0.11.1 的 `apply-migrations` 选取以完成剩余阶段的
   信号。
6. 检测主机 agent 仓库并打印重写说明（永远不要
   从 curl 管道化的脚本自动编辑）。
7. 打印下一步："运行：gbrain autopilot --install"。

一旦安装了 v0.11.1，请重新运行 `gbrain apply-migrations --yes` 以
完成剩余阶段（主机重写 + autopilot 安装）。停止缺口的
`status: "partial"` 记录旨在干净地恢复（它不会
毒化永久迁移路径）。

## 验证修复已落地

```bash
# 1. 首选项存在并且可读
cat ~/.gbrain/preferences.json

# 2. 迁移已记录
cat ~/.gbrain/migrations/completed.jsonl

# 3. Autopilot 正在监督 Minions worker
gbrain autopilot --status
ps aux | grep 'jobs work'

# 4. 作业显示在队列中
gbrain jobs list

# 5. 任何主机特定的 TODO 仍待处理
cat ~/.gbrain/migrations/pending-host-work.jsonl 2>/dev/null || echo "(none — all host work is done)"

# 6. Doctor + skillpack-check 都应该干净
gbrain doctor
gbrain skillpack-check --quiet && echo ok
```

## 如果修复失败

每个阶段都是幂等的。重新运行是安全的。常见失败模式：

- **阶段 B smoke 失败：** schema 不会应用。检查
  `~/.gbrain/config.json` 是否具有有效的 `database_url`（或 `database_path`
  用于 PGLite）。直接运行 `gbrain init --migrate-only` 并查看
  错误。
- **阶段 F install 失败：** 你的主机环境不匹配
  检测到的目标。显式传递 `--target <macos|linux-systemd|ephemeral-container|linux-cron>`。
- **挂起的主机工作永远不会清除：** 你的主机 agent 还没有运送
  处理程序注册。读取
  `~/.gbrain/migrations/pending-host-work.jsonl`，打开
  `skills/migrations/v0.11.0.md`，并按照主机 agent 说明手动
  操作。

## 相关

- `skills/migrations/v0.11.0.md` — 主机 agents 的完整迁移 skill。
- `skills/skillpack-check/SKILL.md` — 何时以及如何运行运行状况检查。
- `docs/guides/plugin-handlers.md` — 主机特定的
  处理程序合约。
- `skills/conventions/cron-via-minions.md` — 规范 cron 重写
  模式。
