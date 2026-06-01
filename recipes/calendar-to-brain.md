---
id: calendar-to-brain
name: Calendar-to-Brain
version: 0.7.0
description: Google Calendar 事件变为可搜索的大脑页面。每日文件包含与会者、地点和会议准备上下文。
category: sense
requires: [credential-gateway]
secrets:
  - name: CLAWVISOR_URL
    description: ClawVisor 网关 URL（选项 A — 推荐，为您处理 OAuth）
    where: https://clawvisor.com — 创建一个代理，激活 Google Calendar 服务
  - name: CLAWVISOR_AGENT_TOKEN
    description: ClawVisor 代理令牌（选项 A）
    where: https://clawvisor.com — 代理设置，复制代理令牌
  - name: GOOGLE_CLIENT_ID
    description: Google OAuth2 客户端 ID（选项 B — 直接 API 访问，您管理令牌）
    where: https://console.cloud.google.com/apis/credentials — 创建 OAuth 2.0 客户端 ID
  - name: GOOGLE_CLIENT_SECRET
    description: Google OAuth2 客户端密钥（选项 B）
    where: https://console.cloud.google.com/apis/credentials — 与客户端 ID 同一页面
health_checks:
  - type: any_of
    label: "认证提供者"
    checks:
      - type: http
        url: "$CLAWVISOR_URL/health"
        label: "ClawVisor"
      - type: env_exists
        name: GOOGLE_CLIENT_ID
        label: "Google OAuth"
setup_time: 20 min
cost_estimate: "$0（两个选项都是免费的）"
---

# Calendar-to-Brain：您的日程表变为可搜索的记忆

每个日历事件都变为可搜索的大脑页面。您的代理知道您明天与谁会面、上次讨论了什么以及什么上下文很重要。会议准备自动进行，因为大脑已经有了历史记录。

## 重要：给代理的说明

**您是安装程序。** 请精确按照这些步骤操作。

**为什么这很重要：** 日历数据是关系历史最丰富的来源。
13 年的日历数据告诉您与谁会面、频率如何、在哪里以及和谁一起。
当有人给您发电子邮件时，大脑已经知道您的会面历史。
当您明天有会议时，代理会自动提取与会者档案。

**输出是每日 markdown 文件：** 每天一个文件，位于
`brain/daily/calendar/{YYYY}/{YYYY-MM-DD}.md`，包含所有事件、与会者和
地点。这些文件是会议准备、关系跟踪和
模式检测的基础。

**不要跳过步骤。在每个步骤后验证。**

## 架构

```
Google Calendar（多个账户）
  ↓（ClawVisor 凭证网关，分页）
Calendar Sync Script（确定性 Node.js）
  ↓ 输出：
  ├── brain/daily/calendar/{YYYY}/{YYYY-MM-DD}.md   （每日事件文件）
  ├── brain/daily/calendar/.raw/events-{range}.json  （原始 API 响应）
  └── brain/daily/calendar/INDEX.md                  （日期范围 + 月度摘要）
  ↓
Agent 读取每日文件
  ↓ 判断调用：
  ├── 与会者丰富（为人员创建/更新大脑页面）
  ├── 会议准备（在明天的会议之前提取上下文）
  └── 模式检测（会议频率、关系温度）
```

## 固执己见的默认设置

**多个日历账户：**
- 工作日历（公司域名）
- 个人日历（gmail.com）
- 以前的公司日历（如果仍可访问）

**每日文件格式：**
```markdown
# 2026-04-10（星期四）

- 09:00-09:30 **团队站会**（工作）— 与 Alice、Bob、Carol
- 10:00-11:00 **董事会会议**（工作）📍 办公室 — 与 Diana、Eduardo、Fiona
- 12:00-13:00 **与 Pedro 共进午餐**（个人）📍 Chez Panisse — 与 Pedro Franceschi
- 14:00-14:30 **与 Jordan 的 1:1**（工作）— 与 Jordan Lee
```

全天的事件首先列出。定时事件按开始时间排序。
取消的事件被跳过。提取与会者姓名（输出中无电子邮件地址）。
括号内的日历标签。带有 📍 emoji 的地点。

**历史回填：** 同步多年的日历数据，而不仅仅是最近的。
常见范围：
- 工作：2020 年至今
- 个人：2014 年至今
这从第一天开始就建立了完整的关系图。

## 先决条件

1. **GBrain 已安装并配置**（`gbrain doctor` 通过）
2. **Node.js 18+**（用于同步脚本）
3. **通过以下之一访问 Google Calendar：**
   - **选项 A：ClawVisor**（推荐，处理 OAuth，无令牌管理）
   - **选项 B：Google OAuth2 直接**（您管理令牌，无需额外服务）

## 设置流程

### 步骤 1：选择并配置日历访问

询问用户："您想如何连接到 Google Calendar？"

**选项 A：ClawVisor（推荐）**
ClawVisor 处理 OAuth、令牌刷新和加密。您永远不会直接接触 Google
凭证。如果您已经将 ClawVisor 用于电子邮件，则使用相同的设置。

**选项 B：Google OAuth2 直接**
直接连接到 Google Calendar API。无需额外服务，但您自己管理
OAuth 令牌。如果您不想要另一个依赖项，这很好。"

#### 选项 A：ClawVisor 设置

告诉用户：
"我需要您的 ClawVisor URL 和代理令牌。
1. 转到 https://clawvisor.com
2. 创建一个代理（或使用现有的）
3. 激活 **Google Calendar** 服务
4. 创建一个常设任务，目的为：'完全访问日历以进行历史
   回填和持续同步。列出事件、读取事件详细信息、搜索
   所有日历。'
   重要提示：任务目的要**宽泛**。狭窄的目的会阻止请求。
5. 复制网关 URL 和代理令牌"

验证：
```bash
curl -sf "$CLAWVISOR_URL/health" && echo "通过：ClawVisor 可达" || echo "失败"
```

**停止直到 ClawVisor 验证通过。**

#### 选项 B：Google OAuth2 设置

告诉用户：
"我需要 Google OAuth2 凭证。具体操作如下：

1. 转到 https://console.cloud.google.com/apis/credentials
   （如果您没有 Google Cloud 项目，请创建一个）
2. 点击顶部的 **'+ CREATE CREDENTIALS'**，选择 **'OAuth client ID'**
3. 如果提示，首先配置 OAuth 同意屏幕：
   - 用户类型：**外部**（或者如果您有 Google Workspace，则选择内部）
   - 应用名称：任意（例如，'GBrain Calendar'）
   - 范围：添加 **'Google Calendar API .../auth/calendar.readonly'**
   - 测试用户：添加您自己的电子邮件
4. 返回凭据，创建 OAuth 客户端 ID：
   - 应用程序类型：**桌面应用**
   - 名称：任意（例如，'GBrain'）
5. 点击 **'创建'**。您将看到客户端 ID 和客户端密钥。
6. 复制两者并粘贴给我。

同时启用 Calendar API：
7. 转到 https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
8. 点击 **'启用'**"

验证凭证已设置：
```bash
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ] \
  && echo "通过：Google OAuth 凭证已设置" \
  || echo "失败：缺少 GOOGLE_CLIENT_ID 或 GOOGLE_CLIENT_SECRET"
```

然后运行 OAuth 流程以获取访问令牌：
```bash
# 同步脚本应处理 OAuth 流程：
# 1. 打开浏览器到具有 calendar.readonly 范围的 Google 授权 URL
# 2. 用户授予访问权限
# 3. 脚本接收授权代码，交换为访问 + 刷新令牌
# 4. 将令牌存储在 ~/.gbrain/google-tokens.json 中
# 5. 到期时自动刷新
```

**停止直到 OAuth 流程完成并且令牌已存储。**

### 步骤 2：识别日历账户

询问用户："我应该同步哪些 Google Calendar 账户？常见设置：
- 工作电子邮件（例如，you@company.com）
- 个人电子邮件（例如，you@gmail.com）
- 任何具有日历历史记录的以前的公司电子邮件"

对于每个账户，注意：
- 电子邮件地址
- 起始年份（回溯同步多远）
- 标签（工作、个人等）

### 步骤 3：设置日历同步脚本

创建同步目录：
```bash
mkdir -p calendar-sync
cd calendar-sync
npm init -y
```

同步脚本需要这些功能：

1. **分页事件检索** —— Google Calendar API 每个请求最多返回 50 个事件。
   脚本必须通过大日期范围进行分页。对稀疏期使用每月块，
   对密集期使用每周块。
2. **每日 markdown 生成** —— 按日期对事件进行分组，格式化为带有
   时间、与会者、地点、日历标签的 markdown
3. **与现有文件合并** —— 如果每日文件已有手动笔记，请在更新日历数据时保留它们
4. **索引生成** —— 创建 INDEX.md，包含日期范围、事件计数、月度摘要
5. **原始 JSON 保存** —— 将原始 API 响应保存到 `.raw/` 以用于来源

### 步骤 4：运行历史回填

这是大型初始同步。根据您拥有多少
年的日历数据，可能需要 10-30 分钟。

```bash
node calendar-sync.mjs --start 2020-01-01 --end $(date +%Y-%m-%d)
```

告诉用户："从 [起始年份] 同步日历历史。这将为每天创建一个
markdown 文件。对于 4 年的数据，预计约有 1,400 个每日文件。"

验证：
```bash
ls brain/daily/calendar/2026/ | head -10
```

应显示每日文件，如 `2026-04-01.md`、`2026-04-02.md` 等。

### 步骤 5：将日历数据导入 GBrain

```bash
gbrain import brain/daily/calendar/ --no-embed
gbrain embed --stale
```

验证：
```bash
gbrain search "meeting" --limit 3
```

应返回带有事件详细信息的日历页面。

### 步骤 6：与会者丰富

这是**您的工作**（代理）。对于日历事件中出现的每个人：

1. **检查大脑**：`gbrain search "attendee name"` —— 他们有页面吗？
2. **如果缺失则创建页面**：显着与会者（出现 3+ 次）获得大脑页面
3. **更新现有页面**：将会议历史添加到时间线：
   `- YYYY-MM-DD | 会议：{事件标题} [来源：Google Calendar]`
4. **关系跟踪**：在编译的真相中注意会议频率：
   "在过去 6 个月中会面 12 次。定期 1:1 节奏。"

### 步骤 7：设置每周同步

日历应每周同步以保持最新：
```bash
# Cron：每周日上午 10 点
0 10 * * 0 cd /path/to/calendar-sync && node calendar-sync.mjs --start $(date -v-7d +%Y-%m-%d) --end $(date +%Y-%m-%d)
```

同步后，导入新数据：
```bash
gbrain sync --no-pull --no-embed && gbrain embed --stale
```

### 步骤 8：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/calendar-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.7.0","status":"ok","details":{"accounts":"ACCOUNT_COUNT","start_year":"YYYY"}}' >> ~/.gbrain/integrations/calendar-to-brain/heartbeat.jsonl
```

告诉用户："Calendar-to-brain 已设置。您有 [N] 天的日历历史
已索引。我现在可以通过从大脑中提取与会者上下文来为您准备会议。
每周同步保持其最新。"

## 实施指南

这些是从同步 13 年日历数据中产生的生产测试模式。

### 智能分块（每月 vs 每周）

```
generate_chunks(start, end, dense_after='2023-01-01')：
  chunks = []
  current = start

  while current < end:
    if current < dense_after:
      next = current + 1_MONTH    // 稀疏期：每月
    else:
      next = current + 7_DAYS     // 密集期：每周

    chunks.append({from: current, to: min(next, end)})
    current = next

  return chunks
```

**为什么：** 稀疏年份（2014-2023）的每月块 = 8 年约 96 次 API 调用。
每周处理所有内容将是 600+ 次调用。每个日历的 `startYear` 避免
拉取空月份（例如，不要为 2020 年创建的日历查询 2014-2020 年）。

### 与会者过滤

```
filter_attendees(attendees):
  return attendees.filter(a =>
    !a.email?.includes('@resource.calendar.google.com') AND  // 会议室
    !a.email?.includes('@group.calendar.google.com') AND     // 邮件列表
    !a.name?.startsWith('YC-SF-')                            // 内部通讯组
  )
```

没有这个，您的与会者列表会被"会议室 A"和
"engineering-all@company.com"污染。您需要实际的人。

### 与现有文件合并（保留手动笔记）

```
write_daily_file(date, events, dir):
  path = f'{dir}/{date}.md'
  calendar_md = format_events(events)

  if file_exists(path):
    existing = read(path)
    if '## Calendar' in existing:
      // 仅替换 Calendar 部分，保留其他所有内容
      before = existing.split('## Calendar')[0]
      after_match = regex_search(existing, /## [A-Z](?!alendar)/)  // 下一部分
      after = after_match ? existing[match_index:] : ''
      write(path, f'{before}## Calendar\n\n{calendar_md}\n{after}')
    else:
      write(path, f'## Calendar\n\n{calendar_md}\n---\n\n{existing}')
  else:
    write(path, calendar_md)
```

**关键：** 仅触及 `## Calendar`。其他所有内容都保留。如果您
手动向每日文件添加了 `## Notes`，它会在重新同步后保留。

### 日期/时间解析边缘情况

```
parse_event_date(event):
  // 全天：event.start = "2024-01-15"（无 T）
  // 定时：event.start = "2024-01-15T10:00:00-08:00"（带 T）
  if 'T' in event.start:
    return event.start[0:10]    // 从日期时间提取日期
  return event.start            // 已经是日期

format_time(iso_str):
  if not iso_str or 'T' not in iso_str: return 'all-day'
  // 提取小时：分钟，转换为 12 小时制
  // 边缘：00:00 = 12:00 AM，12:00 = 12:00 PM，13:00 = 1:00 PM
```

### 设置后代理应测试的内容

1. **每月 vs 每周：** 从 2014 年开始运行，dense_after=2023。验证 2023 年之前
   每年约进行 12 次 API 调用，2023 年之后每月约进行 4 次。
2. **与会者过滤：** 创建带有会议室和邮件列表的会议。
   同步。验证两者都未出现在每日文件中。
3. **合并保留：** 手动向每日文件添加 `## Notes`。同步日历。
   验证笔记已保留。
4. **全天事件：** 在同一天创建全天事件和定时事件。
   验证全天事件首先出现，定时事件按开始时间排序。
5. **取消的事件：** 取消会议。同步。验证它未出现。
6. **每个日历 startYear：** 使用 startYear=2022 同步 2022 年创建的日历。
   验证 2022 年之前没有 API 调用。

## 成本估算

| 组件 | 月成本 |
|-----------|-------------|
| ClawVisor（免费层） | $0 |
| Google Calendar API | $0（在免费配额内） |
| **总计** | **$0** |

## 故障排除

**未返回事件：**
- 检查日历账户电子邮件是否正确
- 检查 ClawVisor 是否已激活 Google Calendar 服务
- 检查常设任务目的是否足够宽泛
- 某些日历在请求的日期范围内可能为空

**缺少与会者姓名：**
- Google Calendar 有时会返回电子邮件地址而不是显示名称
- 同步脚本应从与会者对象中提取显示名称
- 如果没有显示名称，请使用电子邮件前缀（@ 之前）

**重复事件：**
- 同步脚本应是幂等的（相同日期范围 = 相同输出）
- 如果运行多次，现有的每日文件将被覆盖（不追加）

---
*GBrain Skillpack 的一部分。另请参阅：[Email-to-Brain](email-to-brain.md)、[Calendar-to-Brain](calendar-to-brain.md)*
