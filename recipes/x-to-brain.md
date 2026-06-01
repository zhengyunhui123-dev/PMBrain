---
id: x-to-brain
name: X-to-Brain
version: 0.8.1
description: Twitter 时间线、提及和关键词监控流入大脑页面。跟踪删除、参与速度和实时警报。
category: sense
requires: []
secrets:
  - name: X_BEARER_TOKEN
    description: X API v2 Bearer 令牌（Basic 层最低，完整存档搜索 $200/月）
    where: https://developer.x.com/en/portal/dashboard — 创建项目 + 应用，从"Keys and tokens"复制 Bearer Token
health_checks:
  - type: http
    url: "https://api.x.com/2/users/me"
    auth: bearer
    auth_token: "$X_BEARER_TOKEN"
    label: "X API"
setup_time: 15 min
cost_estimate: "$0-200/月（免费层：1 个应用，只读。Basic：$200/月，用于搜索 + 更高限制）"
---

# X-to-Brain：更新您大脑的 Twitter 监控

您的时间线、提及和关键词搜索流入大脑页面。收集器
跟踪删除、参与速度和叙述模式。您醒来就知道
在您睡觉时在 X 上发生了什么。

## 重要提示：给代理的说明

**您是安装程序。** 请精确按照这些步骤操作。

**核心模式：代码用于数据，LLM 用于判断。**
X 收集器是确定性代码。它提取推文、检测删除、跟踪
参与。它**永远不**解释内容。您（代理）读取收集的数据
并做出判断：谁很重要、提到了哪些实体、什么
叙述正在形成。

**为什么顺序执行很重要：**
- 步骤 1 验证 API 密钥。没有它，什么都无法连接到 X。
- 步骤 2 设置收集器。没有它，您没有数据。
- 步骤 3 运行第一次收集。没有数据，您无法丰富。
- 步骤 4 是**您的工作**：读取收集的推文，更新大脑页面。

**不要跳过步骤。不要重新排序。在每个步骤后进行验证。**

## 架构

```
X API v2（Bearer 令牌认证）
  ↓ 三个收集流：
  ├── 自己的时间线：GET /users/{id}/tweets
  ├── 提及：GET /users/{id}/mentions
  └── 关键词搜索：GET /tweets/search/recent
  ↓
X Collector（确定性 Node.js 脚本）
  ↓ 输出：
  ├── data/tweets/{own,mentions,searches}/{id}.json
  ├── data/deletions/{id}.json（通过差异检测）
  ├── data/engagement/{id}.json（速度快照）
  └── data/state.json（分页、速率限制）
  ↓
Agent 读取收集的数据
  ↓ 判断调用：
  ├── 实体检测（人员、提到的公司）
  ├── 大脑页面更新（时间线条目）
  ├── 叙述模式检测
  └── 参与峰值警报
```

## 固执己见的默认设置

**三个收集流：**
1. **自己的时间线** — 您自己的推文，用于您自己的存档和参与跟踪
2. **提及** — 谁在谈论您，用于关系跟踪
3. **关键词搜索** — 您关心的话题，用于信号检测

**删除检测：**
- 比较前一次运行的推文 ID 与当前
- 如果 ID 缺失**并且**推文 < 7 天大，请调用 GET /tweets/{id}
- 404 = 确认已删除。保存原始推文 + 删除时间戳。
- 对您跟踪的账户的删除发出警报。

**参与速度：**
- 跟踪推文的快照点赞/转发/回复
- 如果点赞翻倍**并且**之前的计数 >= 50，则发出警报
- 如果点赞自上次检查以来增加 > 100 绝对数，则发出警报
- 仅当指标实际更改时才写入快照（幂等）

**速率限制感知：**
- Basic 层：时间线 1500 请求/15 分钟，提及 450，搜索 60
- 收集器在 state.json 中跟踪速率限制
- 接近限制时自动回退

## 先决条件

1. **GBrain 已安装并配置**（`gbrain doctor` 通过）
2. **Node.js 18+**（用于收集器脚本）
3. **X Developer 账户** 具有 API 访问权限

## 设置流程

### 步骤 1：获取 X API 凭证

告诉用户：
"我需要您的 X API Bearer 令牌。具体操作位置如下：

1. 转到 https://developer.x.com/en/portal/dashboard
2. 如果您没有开发者账户，请点击'注册'（可用免费层）
3. 创建一个新项目（任意命名，例如，'GBrain'）
4. 在项目中，创建一个新应用
5. 转到应用的'Keys and tokens'标签
6. 在'Bearer Token'下，点击'Generate'（或'Regenerate'）
7. 复制 Bearer Token 并粘贴给我

注意：免费层提供只读访问权限，限制较低。Basic 层（$200/月）
提供 search/recent 端点和更高的限制。Pro 层获得完整存档搜索。"

立即验证：
```bash
curl -sf -H "Authorization: Bearer $X_BEARER_TOKEN" \
  "https://api.x.com/2/users/me" \
  && echo "通过：X API 已连接" \
  || echo "失败：X API 令牌无效"
```

**如果验证失败：** "那没用。常见问题：（1）确保您复制了
Bearer Token，而不是 API Key 或 API Secret，（2）Bearer Token 是以 'AAA...' 开头的长字符串，
（3）如果您刚刚创建了应用，令牌将立即生效。"

**停止直到 X API 验证通过。**

### 步骤 2：获取您的 X 用户 ID

```bash
# 从用户的句柄中查找用户的 X 用户 ID
curl -sf -H "Authorization: Bearer $X_BEARER_TOKEN" \
  "https://api.x.com/2/users/by/username/USERNAME" | grep -o '"id":"[^"]*"'
```

询问用户的 X 句柄（例如，@yourhandle）。查找他们的用户 ID。
保存它 — 收集器需要数字 ID，而不是句柄。

### 步骤 3：配置收集器

创建收集器目录：
```bash
mkdir -p x-collector/data/{tweets/{own,mentions,searches},deletions,engagement}
cd x-collector
```

收集器脚本需要这些功能：

1. **收集** — 从三个流中提取推文：
   - 自己的时间线：`GET /2/users/{id}/tweets`，max_results=100
   - 提及：`GET /2/users/{id}/mentions`，max_results=100
   - 关键词搜索：通过 `GET /2/tweets/search/recent` 的可配置搜索词
2. **删除检测** — 比较前一次运行的推文 ID 与当前。对于缺失的 ID，通过单独的推文查找进行验证。404 = 已删除。
3. **参与跟踪** — 跟踪推文的快照指标。仅当指标更改时才写入。
4. **状态管理** — 将分页令牌、上次运行时间戳、速率限制状态保存到 `data/state.json`
5. **原子写入** — 写入 .tmp 文件，然后重命名（防止崩溃时损坏数据）

根据您关心的内容配置关键词搜索：
```json
{
  "searches": [
    "\"your name\" -from:yourhandle",
    "\"your company\" OR \"your product\"",
    "topic you track"
  ]
}
```

### 步骤 4：运行第一次收集

```bash
node x-collector.mjs collect
```

验证：`ls data/tweets/own/` 应包含推文 JSON 文件。
向用户显示示例："从您的时间线中找到 N 条推文、M 条提及、K 条搜索结果。"

### 步骤 5：丰富大脑页面

这是**您的工作**（代理）。读取收集的推文：

1. **检测实体**：谁发送了推文？提到了谁？哪些公司/话题？
2. **检查大脑**：`gbrain search "person name"` — 我们有页面吗？
3. **更新大脑页面**：对于每个提到的重要人员或公司：
   `- YYYY-MM-DD | 发布了关于 {话题} 的推文 [来源：X，@handle，{日期}]`
4. **跟踪叙述**：如果某人在一周内关于同一话题发布了 3 次以上，请在他们的编译真相中记录该模式
5. **标记删除**：如果跟踪的账户删除了推文，请注明：
   `- YYYY-MM-DD | 已删除的推文："{内容}" [来源：X 删除，检测到 {日期}]`
6. **同步**：`gbrain sync --no-pull --no-embed`

### 步骤 6：设置 Cron

收集器应每 30 分钟运行一次：
```bash
*/30 * * * * cd /path/to/x-collector && node x-collector.mjs collect >> /tmp/x-collector.log 2>&1
```

代理应每天 2-3 次查看收集的数据并运行丰富。

### 步骤 7：记录设置完成

```bash
mkdir -p ~/.gbrain/integrations/x-to-brain
echo '{"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","event":"setup_complete","source_version":"0.8.1","status":"ok","details":{"user_id":"X_USER_ID"}}' >> ~/.gbrain/integrations/x-to-brain/heartbeat.jsonl
```

## 生产模式（v0.8.1）

这些模式来自生产部署，跟踪 19+ 个具有
实时监控的账户。

### 图像 OCR（新）

**问题：** 仅文本收集会错过推文图像中的视觉上下文 —
屏幕截图、图表、带有文本覆盖的表情包、引用屏幕截图。

**修复：** 通过视觉模型（Claude Sonnet 或等效模型）对推文图像运行 OCR：
- 对于每张带有图像的推文，通过视觉 API 提取完整文本内容
- 将 OCR 输出与推文数据一起存储
- 在实体检测和大脑页面更新中包含提取的文本
- 图表/数据可视化：提取数据点，描述发现

这会捕获仅文本收集完全错过的信息。

### 通过过滤流进行实时监控（新）

**问题：** 30 分钟轮询意味着您在 30 分钟后才发现事情。
对于时间敏感的内容（参与峰值、删除、breaking threads），
这太慢了。

**修复：** 使用 Twitter 的过滤流 API（`GET /2/tweets/search/stream`）进行
近实时监控。在几秒钟内捕获出站推文。

**设置：**
1. 添加过滤规则：`POST /2/tweets/search/stream/rules`，使用您的跟踪词
2. 打开持久连接：`GET /2/tweets/search/stream`
3. 在推文到达时处理它们（无轮询延迟）

**要求：** Basic 层（$200/月）最低要求，用于过滤流访问。

**与轮询一起使用：** 流用于实时警报，轮询用于完整性
（流在断开连接期间可能会丢弃推文）。

### 推文评分量表（新）

**问题：** 并非所有推文都值得同等关注。如果没有评分，每个
推文都会获得同等的权重。

**修复：** 在 6 维度量表上评估推文：
1. **触达** — 关注者计数、参与率
2. **相关性** — 与您的兴趣/工作的联系
3. **情绪** — 对您的积极/消极/中性
4. **新颖性** — 新信息 vs 重新哈希
5. **可操作性** — 这是否需要回应？
6. **病毒潜力** — 参与速度、引用推文比率

在 60 分钟后重新评分以跟踪参与轨迹。一条推文在 50 个点赞
在一小时内达到 500，这与停留在 50 的推文是不同的信号。

### 出站推文监控（新）

**问题：** 您发布推文，直到几小时后才注意到参与模式。

**修复：** 每次出站推文后的 60 秒监控窗口：
- 检查参与速度（点赞、回复、引用）
- 标记不寻常的回复与点赞比率（高回复率表示争议）
- 标记如果引用推文比率 > 转发比率（评论，不共享）
- 根据大脑交叉引用提到的账户以获取上下文

### X-to-Brain 管道（新）

每次推文互动都可以自动创建/更新大脑页面：
- 提到的人员有大脑页面吗？附加到他们的时间线
- 提到的新人员？检查重要性门控，如果重要则创建页面
- 推文中的文章 URL？通过文章工作流提取并摄取
- 推文中的视频 URL？排队到转录管道
- 图像？OCR 并提取文本内容

按照 `skills/_brain-filing-rules.md` 进行归档决策。

### Cron 交错（重要）

**问题：** 多个 cron 作业同时触发会导致资源争用
和超时。

**修复：** 错开所有收集计划，以便每分钟最多运行 1 个：
```
# 好：交错
*/30 * * * * x-collector       # :00, :30
5,35 * * * * x-bundle-ingest   # :05, :35
10 */3 * * * social-monitor     # 每 3 小时 :10
# 坏：重叠
*/30 * * * * x-collector
*/30 * * * * x-bundle-ingest   # 同时触发！
```

## 实施指南

这些是从跟踪 19+ 个账户的部署中产生的生产测试模式。

### 删除检测算法

```
detect_deletions(prevIds, currentIds):
  for id in prevIds:
    if id in currentIds: continue          // 仍然存在

    stored = load_tweet(id)
    if not stored: continue                // 从未存储

    // 启发式 1：仅检查 < 7 天大的推文
    age = now - stored.created_at
    if age > 7_DAYS: continue              // 超出 API 窗口

    // 启发式 2：如果最后看到 > 48 小时前，则跳过
    staleness = now - stored.last_updated
    if staleness > 48_HOURS: continue      // 掉出窗口，未删除

    // 启发式 3：已记录？
    if deletion_file_exists(id): continue

    // 验证通过直接 API 调用
    res = GET /tweets/{id}
    if res.status == 404 OR (res.ok AND no data):
      save_deletion(id, original_tweet, detected_at)
      alert(f"删除：{author} 已删除：{preview}")
```

**为什么启发式很重要：** 没有 #2（48 小时 staleness 检查），您会在每次运行时对成千上万个旧推文产生误报。
没有 #1（7 天上限），您将在每次运行时调查成千上万个旧推文。

### 参与速度跟踪

```
track_engagement(id, metrics):
  snapshots = load_snapshots(id)
  last = snapshots[-1] if snapshots else null

  if last AND metrics_equal(last, metrics): return  // 无更改

  snapshots.append({timestamp: now, metrics})
  if len(snapshots) > 100: snapshots = snapshots[-100:]  // 上限增长

  // 警报条件（OR 逻辑）：
  if last:
    old_likes = last.like_count
    new_likes = metrics.like_count

    // 条件 1：已建立推文上的 2 倍（>= 50 点赞）
    if old_likes >= 50 AND new_likes >= old_likes * 2:
      alert(f"速度：{id} 点赞 {old_likes} -> {new_likes}")

    // 条件 2：绝对跳跃 > 100
    elif (new_likes - old_likes) > 100:
      alert(f"速度：{id} 点赞 {old_likes} -> {new_likes}")
```

**阈值设计：** `50` 最小值可防止小推文从 2→4 的噪声。
`100` 绝对跳跃会捕获具有任何基线的推文上的大峰值。

### 原子文件写入

```
atomic_write(path, obj):
  tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)  // 在大多数文件系统上是原子的
```

如果进程在写入中途死亡，`.tmp` 文件会被留下，但原始文件
未受影响。当您有成千上万个每推文 JSON 文件时，这很关键。

### 速率限制处理

```
rate_limits = {}  // 每个端点

after_each_request(endpoint, headers):
  rate_limits[endpoint] = {
    remaining: headers['x-rate-limit-remaining'],
    reset: headers['x-rate-limit-reset']
  }

is_rate_limited(endpoint, min_remaining=2):
  r = rate_limits[endpoint]
  return r AND r.remaining <= min_remaining
```

为每个端点保留 2 个请求，以便其他流仍然可以工作。如果提及
达到限制，自己的时间线和搜索仍然可以运行。

### Stdout 合约

收集器打印 cron 代理可以解析的结构化行：
```
RUN_START:{timestamp}
OWN_TWEETS:{total} ({new} new)
MENTIONS:{total} ({new} new)
DELETION_DETECTED:{id}:{author}:{preview}
VELOCITY_ALERT:{id}:likes:{old}->{new}:{minutes}min
RUN_COMPLETE:{timestamp}:tweets_stored={N}:deletions={N}:velocity_alerts={N}
```

### 设置后代理应测试的内容

1. **删除检测：** 发布推文，收集，删除它，再次收集。
   验证在第二次运行时检测到删除。
2. **速率限制：** 以非常低的剩余配额运行收集。验证它是否
   正常停止并报告跳过了哪些流。
3. **参与：** 找到一条有 45 个点赞的推文。模拟它跳到 90（无警报，
   < 50 阈值）。然后 50→100（警报：2 倍）。然后 30→150（警报：>100 跳跃）。
4. **去重：** 收集，然后点赞您自己的一条推文，再次收集。
   验证 `_collected_at` 已保留（未覆盖）。
5. **原子写入：** 在收集中杀死进程。验证没有损坏的 JSON。

## 成本估算

| 组件 | 月成本 |
|-----------|-------------|
| X API 免费层 | $0（只读，限制低） |
| X API Basic 层 | $200/月（搜索 + 更高限制） |
| X API Pro 层 | $5,000/月（完整存档） |
| **推荐** | **$0（免费）或 $200（basic）** |

免费层适用于个人监控。关键词搜索需要 Basic 层。

## 故障排除

**API 返回 403：**
- 检查您的应用是否具有正确的访问级别（Read 或 Read+Write）
- 免费层应用只能使用基本端点
- 某些端点需要 Basic 或 Pro 层

**速率限制（429）：**
- 收集器会自动遵守速率限制
- 如果频繁达到限制，请将 cron 间隔增加到 60 分钟
- 检查 `data/state.json` 中的速率限制跟踪

**未收集到推文：**
- 验证用户 ID 是否正确（数字，不是句柄）
- 检查 Bearer Token 是否有效（步骤 1 验证）
- 某些账户可能具有受保护的推文（需要 OAuth 2.0 用户上下文）
