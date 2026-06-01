# 队列操作手册

"我的队列看起来卡住了 — 我应该运行什么？" 以下命令按你可能想要的顺序排列。在队列卡住 90+ 分钟且操作员注意到之前的生产事件后，随 v0.19.1 一起发布。

## 第一个信号：作业没有运行

```bash
gbrain doctor --json | jq '.checks[] | select(.name == "queue_health")'
```

`queue_health` 标记两种模式：

- **stalled-forever**：`started_at` 超过 1 小时的活跃作业。
- **waiting-depth**：任何名称的队列深度超过 10（通过 `GBRAIN_QUEUE_WAITING_THRESHOLD` 覆盖）。表示缺少 `maxWaiting`。

## 分诊命令

```bash
# 谁现在处于活跃状态？
gbrain jobs list --status active

# 谁在等待，最大的堆在哪里？
gbrain jobs list --status waiting --limit 50

# 特定作业出了什么问题？
gbrain jobs get <id>
```

## 救援操作（按升级顺序）

```bash
# 强制终止单个卡住的作业：
gbrain jobs cancel <id>

# 完全清除特定作业（最后手段）：
gbrain jobs delete <id>

# 机制本身的健康冒烟：
gbrain jobs smoke --wedge-rescue
```

## 每个子检查的含义

- **stalled-forever** — Worker 认领了作业，开始执行，并且持有行超过一个小时。时钟扫描驱逐超过 2× `timeout_ms` 的作业；如果某个作业仍然活跃，要么没有设置 `timeout_ms`，要么扫描是新部署的并且此作业在其之前。取消它。

- **waiting-depth** — 提交者堆积作业的速度超过了 worker 消耗它们的速度。在提交时或编程的 `queue.add()` 调用上设置 `--max-waiting N`。如果你想要更高的堆，通过 `GBRAIN_QUEUE_WAITING_THRESHOLD=50 gbrain doctor` 提高阈值。

## 自检：worker 甚至没有运行吗？

```bash
# 如果你使用 --no-worker 运行 autopilot，请检查你的外部
# worker（systemd / Docker / OpenClaw service-manager）是否还活着：
gbrain jobs list --status active | head -5
```

如果列表为空并且你的提交继续堆积，则没有 worker 在认领。启动一个：

```bash
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work --concurrency 4
```

## v0.20+ 的后续跟踪

- B7 — `minion_workers` 心跳表用于真实活跃度（需要 `--no-worker` 探测和丢弃的 `queue_health` worker-heartbeat 子检查）。
- B3 — `gbrain doctor --fix` 学习救援队列楔入。
