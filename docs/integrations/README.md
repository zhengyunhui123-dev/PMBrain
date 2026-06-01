# 将数据导入你的 Brain

GBrain 是检索层。但检索的效果取决于你放入的内容。
本目录介绍如何自动将数据流入你的 brain。

## 数据流动方式

```
信号到达（电话、电子邮件、推文、日历事件）
  ↓
收集器捕获它（确定性代码，可靠）
  ↓
Agent 分析它（LLM、判断、实体检测）
  ↓
创建/更新 Brain 页面（编译真相 + 时间线）
  ↓
GBrain 索引它（分块、嵌入、可搜索）
  ↓
下一次查询更智能（复利效应）
```

## 可用的集成

### 自安装配方

这些是你的 agent 可以为你设置的集成配方。
运行 `gbrain integrations` 查看可用配方及其状态。

| 配方 | 类别 | 要求 | 功能 | 设置时间 |
|--------|----------|----------|-------------|------------|
| [ngrok-tunnel](../../recipes/ngrok-tunnel.md) | 基础设施 | — | MCP + 语音的固定公网 URL（$8/月） | 10 分钟 |
| [credential-gateway](../../recipes/credential-gateway.md) | 基础设施 | — | Gmail + 日历访问（ClawVisor 或 Google OAuth） | 15 分钟 |
| [voice-to-brain](../../recipes/twilio-voice-brain.md) | 感知 | ngrok-tunnel | 通过 Twilio + OpenAI Realtime 创建 brain 页面 | 30 分钟 |
| [email-to-brain](../../recipes/email-to-brain.md) | 感知 | credential-gateway | Gmail 消息通过确定性收集器流入实体页面 | 20 分钟 |
| [x-to-brain](../../recipes/x-to-brain.md) | 感知 | — | Twitter 时间线、提及、关键词监控（含删除检测） | 15 分钟 |
| [calendar-to-brain](../../recipes/calendar-to-brain.md) | 感知 | credential-gateway | Google Calendar 事件变为可搜索的每日 brain 页面 | 20 分钟 |
| [meeting-sync](../../recipes/meeting-sync.md) | 感知 | — | Circleback 会议记录自动导入并传播给参会者 | 15 分钟 |

### 手动集成指南

这些需要手动设置（尚无自安装配方）：

| 指南 | 功能 |
|-------|-------------|
| [凭证网关](credential-gateway.md) | 为 Gmail、Calendar、Contacts 访问设置 ClawVisor 或 Hermes |
| [会议和通话 Webhooks](meeting-webhooks.md) | Circleback 会议记录 + Quo/OpenPhone SMS/通话 |

## 如何阅读配方

集成配方是带有 YAML frontmatter 的 markdown 文件。你的 agent 读取配方并引导你完成设置。

```yaml
---
id: voice-to-brain              # 唯一标识符
name: Voice-to-Brain            # 人类可读名称
version: 0.7.0                  # 配方版本
description: Phone calls...     # 功能描述
category: sense                 # sense（数据输入）或 reflex（自动化响应）
requires: []                    # 必须先设置的其他配方
secrets:                        # 需要的 API 密钥和凭证
  - name: TWILIO_ACCOUNT_SID
    description: Twilio account SID
    where: https://console.twilio.com    # 获取此密钥的确切 URL
health_checks:                  # 验证集成是否工作的类型化 DSL
  - type: http
    url: "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json"
    auth: basic
    auth_user: "$TWILIO_ACCOUNT_SID"
    auth_token: "$TWILIO_AUTH_TOKEN"
    label: "Twilio account"
setup_time: 30 min              # 预估设置完成时间
---

[Agent 逐步执行的设置说明...]
```

**配方就是安装程序。** 你的 agent（OpenClaw、Hermes、Claude Code）读取 markdown 正文并执行设置步骤。它会向你询问 API 密钥，验证每个密钥，配置集成，并运行冒烟测试。

### 配方信任边界

只有在 gbrain 包本身内发布的配方（`source install` 中的 `recipes/` 目录，或全局安装副本）才受信任。在运行时从 `$GBRAIN_RECIPES_DIR` 或 cwd 本地的 `./recipes/` 发现的配方被标记为不受信任：它们不能运行 `command` 健康检查，不能运行 `http` 健康检查（SSRF 防御），也不能使用已弃用的字符串 health_check 形式。不受信任的配方仍然可以使用 `env_exists` 和 `any_of` 组合。要发布运行实时检查的配方，请向上游贡献，使其成为包捆绑的一部分。

## 确定性收集器模式

当 LLM 尽管反复提示修复仍在机械任务上失败时，停止与 LLM 对抗。将机械工作转移到代码中。

**代码处理数据。LLM 用于判断。**

- 电子邮件收集：代码拉取带有内置链接的电子邮件（100% 可靠）。LLM 读取摘要、分类、丰富 brain 条目（判断）。
- 推文收集：代码拉取时间线、检测删除、跟踪互动（确定性）。LLM 提取实体、写入 brain 更新（判断）。
- 日历同步：代码拉取事件和参会者（确定性）。LLM 丰富参会者 brain 页面（判断）。

此模式防止"LLM 忘记链接"的失败模式。机械工作必须 100% 可靠。判断工作才是 LLM 的用武之地。

参见[确定性收集器](../guides/deterministic-collectors.md)了解完整模式。

## 架构

有关所有集成构建的共享基础设施（导入管道、分块、嵌入、搜索）的详细信息，请参阅[基础设施层](../architecture/infra-layer.md)。

有关薄套件 + 胖技能的背后的理念，请参阅[薄套件，胖技能](../ethos/THIN_HARNESS_FAT_SKILLS.md)。

---
*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
