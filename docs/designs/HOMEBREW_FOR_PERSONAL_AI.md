# 个人 AI 基础设施的 Homebrew

GBrain 集成的 10 星愿景。发布方法 B（v0.7.0），
在后续版本中向此方向构建。

## 愿景

GBrain 成为个人基础设施操作系统，您生活中的每个信号都自动流经 brain。集成是 **感官**
（数据输入）和 **反射**（对模式的自动化响应）。用户订阅
创建者的实际操作系统，然后自定义它。

```
$ gbrain integrations

  SENSES (数据输入)                          STATUS
  -------------------------------------------------------
  voice-to-brain    电话呼叫 -> brain 页面  活跃    上次呼叫：2小时前
  email-to-brain    Gmail -> 实体更新     活跃    今天 47 封电子邮件
  x-to-brain        Twitter -> 媒体页面      活跃    跟踪了 312 条推文
  calendar-to-brain Google Cal -> 会议准备  活跃    明天 3 个会议
  photos-to-brain   相机胶卷 -> 视觉记忆   可用
  slack-to-brain    Slack -> 对话索引      可用
  rss-to-brain      RSS 订阅 -> 媒体页面   可用

  REFLEXES (自动化响应)                STATUS
  -------------------------------------------------------
  meeting-prep      会议前向我简要介绍    活跃    下次：明天上午 9 点
  entity-enrich     自动丰富新联系人    活跃    今天丰富了 12 个
  dream-cycle       夜间 brain 维护       活跃    上次运行：凌晨 3 点
  deal-tracker      交易变更警报         可用
  follow-up-nudge  提醒 stale 线程       可用

  本周：摄入了 1,247 个信号。顶部：电子邮件 (47%)、语音 (23%)、X (18%)。
  创建了 34 个新实体页面。转录了 7 次呼叫。

  运行 'gbrain integrations show <id>' 以获取设置详细信息。
```

用户感觉："我的 brain 还活着。它在关注我关心的一切，
并且每天都在变得更聪明。我不需要写任何代码。我只是
在代理询问时说 yes。"

## 架构：感官与反射

### 配方格式（YAML 前置元信息 + markdown 正文）

```yaml
---
id: voice-to-brain
name: Voice-to-Brain
version: 0.7.0
description: 电话呼叫通过 Twilio + OpenAI Realtime + GBrain MCP 创建 brain 页面
category: sense
requires: [credential-gateway]
secrets:
  - name: TWILIO_ACCOUNT_SID
    description: Twilio 账户 SID
    where: https://console.twilio.com
  - name: OPENAI_API_KEY
    description: OpenAI API 密钥（用于 Realtime 语音）
    where: https://platform.openai.com/api-keys
health_checks:
  - curl -s https://api.twilio.com/2010-04-01 > /dev/null
  - curl -s https://api.openai.com/v1/models > /dev/null
setup_time: 30 min
---

[代理执行的有主见的设置说明...]
```

### 依赖关系图

配方在前置元信息中声明 `requires`。CLI 在
设置之前解析依赖关系。
如果 voice-to-brain 需要 credential-gateway，代理会
首先设置 credential-gateway。

```
credential-gateway
  ├── voice-to-brain（需要 Twilio 的凭证）
  ├── email-to-brain（需要 Gmail 的凭证）
  └── calendar-to-brain（需要 Google Calendar 的凭证）

x-to-brain（独立，直接使用 X API）
```

### 健康仪表板

`gbrain integrations doctor` 从每个已配置的配方运行 health_checks：
```
$ gbrain integrations doctor
  voice-to-brain:   ✓ Twilio 可达  ✓ OpenAI 密钥有效  ✓ ngrok 隧道启动
  email-to-brain:   ✓ Gmail 认证有效   ✗ 48 小时内无电子邮件（检查 cron）
  OVERALL: 1 个警告
```

### 感官分析

`gbrain integrations stats` 聚合心跳数据：
```
$ gbrain integrations stats
  本周：摄入了 1,247 个信号
  顶部来源：电子邮件 (47%)、语音 (23%)、X (18%)、日历 (12%)
  创建了 34 个新实体页面
  转录了 7 次呼叫
  Brain 增长：12,400 → 12,834 页面 (+434)
```

### 反射规则引擎（未来）

反射是在 brain 状态更改时触发的配方：

```yaml
---
id: deal-tracker
category: reflex
triggers:
  - type: page_updated
    filter: {type: deal, field: status}
  - type: timeline_entry
    filter: {source: email, mentions: deal}
action: alert
---

当交易页面的状态更改或新电子邮件提及交易时，
使用来自 brain 的上下文提醒用户。
```

## 路线图

| 版本 | 发布内容 | 关键配方 |
|---------|-----------|------------|
| v0.7.0 | 配方格式、CLI、SKILLPACK 拆分 | voice-to-brain |
| v0.8.0 | 另外 3 个感官、反射格式 | 电子邮件、X、日历 |
| v0.9.0 | 社区配方、安装执行器 | 社区提交 |
| v1.0.0 | 完整感官/反射、健康仪表板 | meeting-prep、dream-cycle |

## 关键设计决策

1. **GBrain 是确定性基础设施。** 跨感官关联、
   检测和智能响应是代理的工作（OpenClaw/Hermes）。
   GBrain 提供管道。

2. **代理就是运行时。** 没有 npm 包、Docker 镜像或确定性
   脚本。配方 markdown 就是安装程序。代理读取它并
   完成工作。

3. **非常有主见的默认值。** 将创建者的确切生产设置作为
   默认发布。用户从那里自定义。未知呼叫者被筛选。安静
   时间被强制执行。每次呼叫时进行 Brain 优先查找。

4. **代理可读输出。** 所有 CLI 输出必须可由代理解析（--json
   标志）。迁移文件包括代理指令。代理是主要
   消费者，而不是人类。
