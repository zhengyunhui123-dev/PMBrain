# 安静时间与感知时区的消息推送

## 目标
在睡眠时间内暂停所有通知，将保留的消息合并到晨间简报中，并在用户旅行时自动调整。

## 用户获得什么
没有它： cron 作业在凌晨 3 点 ping。一次糟糕的通知，用户就会禁用整个系统。

有了它：brain 在夜间工作（梦境循环、收集器、丰富），但通知会保留到早晨。旅行到东京？系统会根据你的日历自动调整，无需更改配置。

## 实现

### 安静时间门控

每个发送通知的 cron 作业必须首先检查安静时间。

```
QUIET_START = 23  // 当地时间晚上 11 点
QUIET_END = 8     // 当地时间早上 8 点

is_quiet(local_hour):
  return local_hour >= QUIET_START OR local_hour < QUIET_END
```

**在发送任何通知之前：**
1. 确定用户的当前时区（来自配置或心跳状态）
2. 将当前 UTC 时间转换为本地时间
3. 如果是安静时间：保留消息，不要发送

### 保留的消息

在安静时间内，输出会转到保留目录而不是发送：

```
if is_quiet():
  mkdir -p /tmp/cron-held/
  write("/tmp/cron-held/{job-name}.md", output)
  exit  // 不要发送
else:
  send(output)
```

晨间简报会接收保留的消息：

```
morning_briefing():
  held_files = list("/tmp/cron-held/*.md")
  if held_files:
    briefing += "## 夜间更新\n\n"
    for file in held_files:
      briefing += read(file)
      delete(file)
```

这样什么都不会丢失。夜间 cron 结果会被折叠到用户早晨看到的第一件事中。

### 时区感知

代理应该知道用户在哪个时区。将其存储在代理的操作状态中：

```json
{
  "currentLocation": {
    "timezone": "US/Pacific",
    "city": "San Francisco"
  }
}
```

**在以下情况下更新时区：**
- 日历显示用户飞往某地（检查航空公司/酒店活动）
- 用户提到身处不同城市
- 用户的活跃时间发生变化（他们在太平洋时间凌晨 3 点回复 = 他们可能在旅行）

**显示给用户的所有时间都应该是他们的本地时区。** 永远不要显示 UTC 或用户不在的时区。

### Shell 实现

```bash
#!/bin/bash
# quiet-hours-gate.sh — 在任何通知之前运行

TIMEZONE="${USER_TIMEZONE:-US/Pacific}"
LOCAL_HOUR=$(TZ="$TIMEZONE" date +%H)

if [ "$LOCAL_HOUR" -ge 23 ] || [ "$LOCAL_HOUR" -lt 8 ]; then
  echo "QUIET_HOURS=true"
  exit 1  # 不要发送
fi

echo "QUIET_HOURS=false"
exit 0  # 可以发送
```

**在 cron 作业脚本中：**

```bash
# 首先检查安静时间
if ! bash scripts/quiet-hours-gate.sh; then
  mkdir -p /tmp/cron-held
  echo "$OUTPUT" > /tmp/cron-held/$(basename "$0" .sh).md
  exit 0
fi

# 不是安静时间 — 正常发送
send_notification "$OUTPUT"
```

### 可配置时间

一些用户想要不同的安静时间。存储配置：

```json
{
  "quiet_hours": {
    "start": 23,
    "end": 8,
    "enabled": true
  }
}
```

设置 `enabled: false` 以完全禁用安静时间（例如，用于 24/7 监控）。

## 棘手的地方

1. **在每个作业上进行门控。** 安静时间检查必须在每个产生通知的 cron 作业之前运行。即使一个作业跳过了门控，用户也会在凌晨 3 点收到 ping 并且对整个系统失去信任。没有例外。

2. **必须接收保留的消息。** 如果晨间简报没有读取 `/tmp/cron-held/`，夜间结果会静默消失。验证简报技能读取并清除保留目录。或者，孤立的保留文件意味着接收集成已损坏。

3. **时区自动检测是脆弱的。** 基于日历的时区检测依赖于用户具有带位置数据的航空公司/酒店活动。如果用户在没有日历条目的情况下预订旅行，系统将无法检测到移动。回退到活动时间分析（在太平洋时间凌晨 3 点回复 = 可能不再在太平洋时间）并在不确定时询问用户。

## 如何验证

1. **将安静时间设置为当前小时。** 暂时将 `QUIET_START` 设置为当前小时前 1 小时，将 `QUIET_END` 设置为当前小时后 1 小时。触发 cron 作业。验证输出转到 `/tmp/cron-held/` 而不是被发送。

2. **检查保留消息接收。** 在步骤 1 之后，运行或模拟晨间简报。验证保留的消息出现在"夜间更新"部分，并且文件从 `/tmp/cron-held/` 中删除。

3. **验证时区调整。** 将时区配置更改为当前处于安静时间的时区。触发通知。验证它被保留。将时区更改回你的真实时区（处于活跃时间）。再次触发。验证它被发送。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
