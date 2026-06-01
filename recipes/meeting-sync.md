---
id: meeting-sync
name: Meeting Sync
version: 0.7.0
description: Circleback 的会议记录自动导入大脑页面，包含与会者检测和实体传播。
category: sense
requires: []
secrets:
  - name: CIRCLEBACK_TOKEN
    description: Circleback API 令牌，用于访问会议数据
    where: https://app.circleback.ai — 设置 > API > 生成令牌
health_checks:
  - type: http
    url: "https://app.circleback.ai/api/mcp"
    method: POST
    headers:
      Authorization: "Bearer $CIRCLEBACK_TOKEN"
      Content-Type: "application/json"
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}'
    label: "Circleback API"
setup_time: 15 min
cost_estimate: "$0-17/月（Circleback 免费层 10 次会议/月，Pro $17/月 无限制）"
---

# Meeting Sync：变为大脑页面的会议记录

每个会议都会自动录制、转录并导入您的大脑，
包含与会者检测、实体传播和操作项提取。您再也不需要
记笔记。大脑会记住说了什么、谁说的以及接下来需要
做什么。

## 重要：给代理的说明

**您是安装程序。** 请精确按照这些步骤操作。

**为什么这是高价值的：** 会议记录是最丰富的信号来源。
一个 30 分钟的会议会提到 5-10 个人、3-5 家公司，并生成 2-3 个操作
项。每一个都应该传播到相关的大脑页面。没有这个配方，
会议就是黑洞。有了它，每一次会议都会增强大脑。

**流程：**
1. Circleback 录制并转录会议（自动，无需用户操作）
2. 同步脚本从 Circleback API 提取已完成的会议
3. 每个会议在 `brain/meetings/{YYYY-MM-DD}-{slug}.md` 变为一个大脑页面
4. **您（代理）** 将实体传播到人员/公司页面

**不要跳过步骤。在每个步骤后验证。**

## 架构

```
视频通话（Zoom、Google Meet、Teams）
  ↓ Circleback 机器人自动加入
Circleback（录制 + 转录 + AI 摘要）
  ↓ API（JSONRPC 2.0 over HTTP，SSE 响应）
Meeting Sync Script（确定性 Node.js）
  ↓ 输出：
  └── brain/meetings/{YYYY-MM-DD}-{slug}.md
      - 前置元数据：source_id、date、duration、attendees、location
      - 带有说话者标签和时间戳的转录
      - 从标题推断的标签
  ↓
Agent 读取会议页面
  ↓ 判断调用：
  ├── 实体检测（人员、公司、主题）
  ├── 传播到与会者大脑页面（时间线条目）
  ├── 操作项提取
  └── 与日历数据交叉引用
```

## 固执己见的默认设置

**会议页面格式：**
```markdown
---
type: meeting
source_id: cb_abc123
source_type: circleback
title: 每周团队同步
date: 2026-04-10
duration: 32 min
attendees: [Alice Chen, Bob Park, Carol Wu]
location: Google Meet
tags: [team, weekly, sync]
---

## 关键点
- 讨论了 Q2 路线图优先级
- Alice 被 API 迁移阻塞
- Bob 的原型已准备好审查

## 操作项
- [ ] Alice：周五前解除 API 迁移阻塞
- [ ] Bob：在 Slack 中分享原型链接
- [ ] Carol：安排下周的设计审查

---

## 转录

**Alice Chen** (00:00): 让我们从路线图更新开始...
**Bob Park** (02:15): 原型基本上完成了...
**Carol Wu** (05:30): 我对新流程有一些设计反馈...
```

**与会者过滤：**
- 跳过日历资源（例如，"YC-SF 会议室"）
- 跳过群组地址（例如，"team@company.com"）
- 提取显示名称，而不是电子邮件地址

**通过 source_id 幂等：** 如果具有相同 `source_id` 的会议已经
在大脑中存在，跳过它。无重复。

## 先决条件

1. **GBrain 已安装并配置**（`gbrain doctor` 通过）
2. **Node.js 18+**（用于同步脚本）
3. **Circleback 账户**（https://circleback.ai）并录制了会议

## 设置流程

### 步骤 1：获取 Circleback API 令牌

告诉用户：
"我需要您的 Circleback API 令牌。具体位置如下：

1. 转到 https://app.circleback.ai
2. 点击您的个人资料图标（右上角）> 设置
3. 转到 API 部分
4. 生成新的 API 令牌（或复制现有的）
5. 粘贴给我

注意：Circleback 的免费层每月最多录制 10 次会议。Pro（$17/月）
无限制。您至少需要一次录制的会议才能同步工作。"

立即验证：
```bash
curl -sf -H "Authorization: Bearer $CIRCLEBACK_TOKEN" \
  "https://app.circleback.ai/api/mcp" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | grep -q '"result"' \
  && echo "通过：Circleback API 已连接" \
  || echo "失败：Circleback 令牌无效"
```

**如果验证失败：** "那没用。常见问题：（1）确保复制了
完整的令牌，（2）令牌是长十六进制字符串，（3）检查您的 Circleback
账户是否处于活动状态。"

**停止直到 Circleback 验证通过。**

### 步骤 2：设置会议同步脚本

```bash
mkdir -p meeting-sync
cd meeting-sync
npm init -y
```

同步脚本需要这些功能：

1. **列出会议** —— 使用日期范围调用 Circleback API `list_meetings`
   （SSE 响应格式，解析流式事件）
2. **提取会议数据** —— 标题、与会者、转录、持续时间、日期
3. **Slugify 标题** —— "Weekly Team Sync" → `weekly-team-sync`
4. **检查现有** —— 如果 `brain/meetings/{date}-{slug}.md` 存在则跳过
5. **格式化为 markdown** —— 前置元数据 + 关键点 + 操作项 + 转录
6. **过滤与会者** —— 移除日历资源、群组，提取显示名称
7. **推断标签** —— 从标题关键词（例如，"board" → board，"1:1" → 1-on-1）

### 步骤 3：运行首次同步

```bash
node meeting-sync.mjs --days 7
```

这将同步过去 7 天的会议。对于完整回填：
```bash
node meeting-sync.mjs --start 2026-01-01 --end $(date +%Y-%m-%d)
```

验证：
```bash
ls brain/meetings/ | head -10
```

应显示类似 `2026-04-10-weekly-team-sync.md` 的文件。

告诉用户："找到并同步了 N 次会议。以下是最新的：[列出 3 个]。"

### 步骤 4：导入到 GBrain

```bash
gbrain import brain/meetings/ --no-embed
gbrain embed --stale
```

验证：
```bash
gbrain search "meeting" --limit 3
```

### 步骤 5：传播到实体页面

这是**您的工作**（代理）。对于每个会议：

1. **读取会议页面** —— 了解谁参加了以及讨论了什么
2. **对于每个与会者**，检查大脑：`gbrain search "attendee name"`
   - 如果页面存在：附加时间线条目：
     `- YYYY-MM-DD | 会议：{标题}。讨论了：{与此人相关的关键点} [来源：Circleback]`
   - 如果没有页面且人物显着：创建一个大脑页面
3. **对于每个提到的公司**：更新公司页面时间线
4. **操作项**：如果会议有操作项，确保它们被跟踪
5. **与日历交叉引用**：将会议页面链接到日历事件
6. **同步**：`gbrain sync --no-pull --no-embed`

### 步骤 6：设置 Cron

在工作日每天 3 次同步：
```bash
# 工作日上午 10 点、下午 4 点、晚上 9 点 PT
0 10,16,21 * * 1-5 cd /path/to/meeting-sync && node meeting-sync.mjs >> /tmp/meeting-sync.log 2>&1
```

默认（无标志）：同步昨天和今天。

### 步骤 7：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/meeting-sync
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok"}' >> ~/.gbrain/integrations/meeting-sync/heartbeat.jsonl
```

告诉用户："会议同步已设置。Circleback 录制的每一次会议
都会自动变为可搜索的大脑页面。与会者页面会随
会议历史更新。操作项被提取。同步在工作日每天运行 3 次。"

## 实施指南

这些是从同步 280+ 会议记录中产生的生产测试模式：

### SSE 响应解析

Circleback 通过 SSE（Server-Sent Events）返回 JSONRPC 2.0：
```
call_circleback(tool_name, args):
  body = {jsonrpc: '2.0', id: next_id(), method: 'tools/call',
          params: {name: tool_name, arguments: args}}

  res = POST CIRCLEBACK_ENDPOINT, body,
        headers: {Authorization: Bearer TOKEN, Accept: 'application/json, text/event-stream'}

  text = res.text()
  for line in text.split('\n'):
    if line.startswith('data: '):
      json = JSON.parse(line[6:])             // 剥离 "data: "
      if json.result?.content?.[0]?.text:
        return JSON.parse(json.result.content[0].text)  // 双重解析
      if json.error:
        throw json.error
```

**不明显的：** 响应是 SSE 内的 JSON，在 JSONRPC 内。您必须：
1. 剥离 `data: ` 前缀
2. 将 SSE 行解析为 JSON
3. 钻取到 `result.content[0].text`
4. 将**其**解析为 JSON  again（它是包含 JSON 的字符串）

### 幂等性（双重检查）

```
meeting_exists(source_id):
  // 方法 1：grep 所有会议文件的 source_id
  result = shell(f'grep -rl "source_id: {source_id}" {MEETINGS_DIR}/')
  if result: return true

  // 方法 2：检查文件名（备份）
  slug = slugify(meeting.name)
  if file_exists(f'{MEETINGS_DIR}/{date}-{slug}.md'): return true

  return false
```

**为什么双重检查：** grep 捕获 source_id 匹配，即使文件名已更改。
文件存在捕获 grep 失败的情况（例如，权限问题）。

### 从会议名称自动标记

```
auto_tag(meeting_name):
  name = meeting_name.toLowerCase()
  tags = []
  if 'office hours' in name or ' oh ' in name: tags.push('oh')
  if 'standup' in name or 'sync' in name: tags.push('sync')
  if '1:1' in name or '1on1' in name: tags.push('1on1')
  if 'board' in name: tags.push('board')
  if 'policy' in name or 'civic' in name: tags.push('civic')
  if not tags: tags.push('meeting')
  return tags
```

### 会议页面结构

```
---
title: "每周团队同步"
type: meeting
date: 2026-04-10
duration: 32 min
source: circleback
source_id: cb_abc123
attendees:
  - {name: Alice Chen, email: alice@company.com}
  - {name: Bob Park, email: bob@company.com}
tags: [sync]
---

# 每周团队同步

## 摘要
[Circleback AI 摘要]

## 与会者
- Alice Chen
- Bob Park

## 操作项
- [ ] Alice：周五前解除 API 迁移阻塞

---

## 转录

**Alice Chen** (00:00): 让我们从路线图开始...
**Bob Park** (02:15): 原型基本上完成了...
```

### Git 在同步后提交

```
if new_meetings_created > 0:
  shell('git add -A', cwd=BRAIN_DIR)
  msg = f'sync: {count} meeting(s) from Circleback ({start} to {end})'
  shell(f'git commit -m "{msg}"', cwd=BRAIN_DIR)
  shell('git push', cwd=BRAIN_DIR)
```

同步脚本自动提交并推送。这会触发 GBrain 的
实时同步以索引新页面。

### 设置后代理应测试的内容

1. **SSE 解析：** 验证 `SearchMeetings` 返回可解析的数据（双重 JSON
   解析是最常见的失败点）。
2. **幂等性：** 同步一次会议，手动向文件添加注释，再次同步。
   验证会议被跳过（未重新创建或覆盖）。
3. **与会者过滤：** 同步在与会者中包含会议室的会议。
   验证会议室未出现在与会者列表中。
4. **自动标记：** 同步名为 "1:1 with Sarah" 的会议。验证标签是 `1on1`。
5. **转录格式：** 验证说话者姓名和时间戳格式
   正确（说话者粗体，时间戳在括号内）。
6. **Git 提交：** 同步 2+ 次会议。验证 git 提交消息包含计数。

## 成本估算

| 组件 | 月成本 |
|-----------|-------------|
| Circleback 免费层 | $0（10 次会议/月） |
| Circleback Pro | $17/月（无限制） |
| **推荐** | **$17/月（Pro）** |

## 故障排除

**未找到会议：**
- 检查 Circleback 是否已录制会议（打开 Circleback 仪表板）
- Circleback 机器人必须加入会议才能录制工作
- 检查日期范围：`--days 30` 以扩大搜索

**转录为空：**
- 某些会议可能没有转录（例如，无音频，机器人被移除）
- 检查特定会议的 Circleback 仪表板状态

**重复会议：**
- 同步脚本通过 source_id 检查现有文件
- 如果出现重复，幂等性检查可能失败
- 手动删除重复项并重新运行同步

---
*GBrain Skillpack 的一部分。另请参阅：[Email-to-Brain](email-to-brain.md)、[Calendar-to-Brain](calendar-to-brain.md)*
