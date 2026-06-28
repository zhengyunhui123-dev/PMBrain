# PMBrain 本地双仓库上游能力融合开发计划

> 执行工具：Codex  
> PMBrain 本地仓库：`D:\cursor-claude\PMBrain`  
> GBrain 上游本地仓库：`D:\cursor-claude\gbrain`  
> 修改目标：只修改 PMBrain，本地读取 GBrain 作为能力参考和代码来源  
> 禁止事项：不修改 GBrain、不从 GitHub 重新拉取、不整仓合并、不用上游核心文件覆盖 PMBrain

---

# 1. 先读懂任务

本次开发不是重新写一套功能，也不是把 GBrain 覆盖到 PMBrain。

两个仓库的关系：

```text
D:\cursor-claude\PMBrain
    = 当前产品主仓库
    = 最终只修改这里

D:\cursor-claude\gbrain
    = 上游参考仓库
    = 只读
    = 从这里复制独立模块、测试和具体 commit 的修改思路
```
任何上游能力移植都不得破坏以下内容：

## 1.1 产品能力

- PMBrain 中文品牌与中文界面。
- Admin Console。
- 自然语言控制台。
- Windows Electron 桌面版。
- ChatGPT Tunnel。
- HTTP MCP、stdio MCP、OAuth。
- CodeBuddy、Cursor、Claude Code、Codex 接入。
- 项目管理知识库定位。
- PM schema、PM skills 和项目管理相关数据结构。

## 1.2 数据能力

- Markdown。
- Word、WPS、PDF、Excel、CSV。
- 图片、扫描件、音频。
- Office 文件内存解析。
- 非 Git 文件夹 Source。
- Git Source。
- PGLite。
- Postgres。

## 1.3 模型能力

- 智谱。
- MIMO。
- DeepSeek。
- OpenAI。
- Anthropic。
- Ollama。
- OpenAI-compatible providers。
- 当前 embedding、rerank 和 gateway 配置。

## 1.4 配置兼容

- `~/.pmbrain/config.json`
- 对旧 `~/.gbrain/config.json` 的兼容读取。
- 当前数据库与 migration。
- 当前 `1.x` 版本号体系。

---
Codex 在修改任何功能前，必须先给该功能标记移植类型。

## A 类：直接复制型

特征：

- 上游新增独立文件。
- 依赖少。
- 主要是纯函数、算法或基础原语。
- 不包含 PMBrain 已修改过的产品层代码。

处理方式：

1. 从上游复制文件。
2. 修改 import。
3. 修改环境变量前缀。
4. 修改 CLI 名称与用户提示。
5. 接入 PMBrain 现有调用链。
6. 保留上游测试并改造成 PMBrain 测试。

优先候选：

```text
src/core/db-pacer.ts
src/core/pace-mode.ts
部分 watchdog
部分 cooldown/backoff
部分 advisor 规则框架
部分 relational intent
部分 spend posture 纯配置逻辑
```

## B 类：算法复制 + PMBrain Adapter

特征：

- 核心算法可复用。
- 但依赖上游 Source、Engine、MCP、CLI 或配置结构。
- 不能直接在 PMBrain 中原样运行。

处理方式：

```text
上游核心算法
    ↓
PMBrain Adapter
    ↓
PMBrain Engine / Source / MCP / Admin / CLI
```

优先候选：

```text
volunteer_context
gbrain watch
brain-resident skillpack
advisor
git durability
spend posture
relational recall
```

## C 类：仅移植 commit diff

特征：

- PMBrain 和上游都有同名核心文件。
- 两边都已经进行大量修改。
- 上游整文件覆盖会冲掉 PMBrain 功能。

禁止整文件复制：

```text
src/core/db.ts
src/core/postgres-engine.ts
src/core/engine.ts
src/core/types.ts
src/core/pglite-engine.ts
src/commands/sync.ts
src/cli.ts
src/mcp/*
Admin Server
Admin Console 核心文件
```

处理方式：

1. 找到上游对应版本或 commit。
2. 查看该 commit 的 diff。
3. 标记真正新增的逻辑。
4. 在 PMBrain 当前文件中手动移植该逻辑。
5. 保留 PMBrain 之后增加的所有代码。
6. 添加回归测试。

核心原则：

```text
能直接复制的独立模块，直接复制到 PMBrain；
有依赖的模块，复制核心算法并接入 PMBrain；
PMBrain 和 GBrain 都存在的核心文件，只对比并移植需要的代码段；
禁止整文件覆盖 PMBrain。
```

---

# 2. Codex 开始时必须做的事情

在 PowerShell 中进入 PMBrain：

```powershell
cd D:\cursor-claude\PMBrain
git status
git rev-parse HEAD
```

检查 GBrain：

```powershell
cd D:\cursor-claude\gbrain
git status
git rev-parse HEAD
git log --oneline -20
```

回到 PMBrain：

```powershell
cd D:\cursor-claude\PMBrain
```

如 PMBrain 当前存在用户未提交的修改：

- 不要覆盖。
- 不要 reset。
- 不要 checkout 丢弃。
- 先记录修改文件。
- 在保留现有修改的基础上继续工作。

建议建立本地开发分支：

```powershell
git checkout -b feat/upstream-capability-fusion
```

如果分支已存在，则继续使用，不重复创建。

---

# 3. 本次到底要修改什么

本次主要修改 8 组能力。

---

## 改动一：大批量同步和向量化自动限速

### 当前问题

PMBrain 在一次导入大量文件、批量生成 embedding 或执行大规模同步时，可能同时发起太多数据库写入和模型请求。

可能出现：

- PgBouncer 连接池压力过大。
- Postgres 连接等待。
- 任务越来越慢。
- 大量 retry。
- PGLite 写入冲突。
- Dream 的 embed 阶段卡住。

### 上游可直接利用的内容

从：

```text
D:\cursor-claude\gbrain\src\core\db-pacer.ts
D:\cursor-claude\gbrain\src\core\pace-mode.ts
```

读取代码。

如果 PMBrain 没有同名文件，优先复制到：

```text
D:\cursor-claude\PMBrain\src\core\db-pacer.ts
D:\cursor-claude\PMBrain\src\core\pace-mode.ts
```

### 需要接入的位置

在 PMBrain 中找到并接入：

- Source sync。
- 普通 embedding。
- stale embedding backfill。
- Dream embed phase。
- Office 文件批量导入后的 embedding。
- Admin Console 发起的同步和向量化任务。

### 用户最终能感受到的变化

新增四个速度档位：

```text
off
gentle
balanced
aggressive
```

含义：

- `off`：不自动限速。
- `gentle`：保守，适合 PGLite 和配置较低的电脑。
- `balanced`：默认模式，兼顾速度和稳定。
- `aggressive`：更快，但数据库压力更高。

Admin Console 要显示：

- 当前档位。
- 当前并发数。
- 当前 batch size。
- 数据库延迟。
- 是否正在自动降速。

### 主要新增或修改文件

优先新增：

```text
src/core/db-pacer.ts
src/core/pace-mode.ts
```

预计修改：

```text
src/commands/sync.ts
embedding/backfill 对应命令文件
src/commands/dream.ts 或 Dream embed phase 文件
Office 导入的 embedding 调用位置
Admin API
Admin Console 任务状态页面
```

不要为了接入 pacer 重写整个 Engine。

---

## 改动二：后台任务更稳定，卡住后能自动恢复

### 当前问题

PMBrain 的 Dream、同步、minion 或 supervisor 在数据库瞬断、某个 Source 失败、任务卡住时，可能出现：

- 后续任务永久停止。
- 同一个失败 Source 每轮都重试。
- 数据库连接被临时 Engine 关闭。
- 任务显示 running，但没有实际进度。
- 退出时后台写入还没结束，数据库先断开。

### 上游要学习和移植的内容

在 GBrain 中搜索并读取：

```text
supervisor
cooldown
watchdog
stall
heartbeat
background-work
abort
reconnect
```

重点参考：

- per-source 故障冷却。
- sync stall watchdog。
- supervisor 自愈。
- 后台队列退出前 drain。
- reconnect single-flight。

### PMBrain 要增加的能力

#### 每个 Source 独立冷却

例如某个 Source 连续失败：

```text
第一次失败：短暂等待
第二次失败：等待更久
第三次失败：进一步延长
```

其他 Source 不受影响。

Admin Console 显示：

- 失败次数。
- 下次重试时间。
- 最近错误。
- “立即重试”按钮。

#### 同步停滞看门狗

增加兼容配置：

```text
PMBRAIN_SYNC_STALL_ABORT_SECONDS
GBRAIN_SYNC_STALL_ABORT_SECONDS
```

默认 900 秒。

只有同时满足以下情况才判断卡住：

- 没有进度更新。
- 没有 heartbeat。
- 没有 checkpoint 更新。
- 状态仍然是 running。

卡住后：

- 安全停止当前任务。
- 保存恢复点。
- 下次从恢复点继续。
- 不把整个 Source 判定为永久失败。

#### 数据库连接所有权

重点对比两边：

```text
D:\cursor-claude\PMBrain\src\core\db.ts
D:\cursor-claude\gbrain\src\core\db.ts

D:\cursor-claude\PMBrain\src\core\postgres-engine.ts
D:\cursor-claude\gbrain\src\core\postgres-engine.ts
```

只移植以下逻辑：

- 谁创建 module singleton，谁才有权关闭。
- 临时 Borrower Engine 不得关闭共享数据库。
- 多个并发 reconnect 只能实际执行一次。
- 关闭连接前先摘除旧引用。
- reconnect 后 ConnectionManager 不再使用旧 pool。

绝对禁止用 GBrain 文件覆盖 PMBrain 文件。

### 用户最终能感受到的变化

- Dream 不再执行一半后报数据库未连接。
- 单个知识库坏掉不会拖死所有后台任务。
- 卡住的同步会自动停止并保留进度。
- 数据库恢复后后台任务继续工作。
- Admin 可以看到任务为什么暂停、何时重试。

---

## 改动三：向量化之前先告诉用户大概要花多少钱

### 当前问题

PMBrain 做 embedding 时，用户不知道：

- 本次会处理多少文件。
- 会生成多少 chunk。
- 大约消耗多少 token。
- 是只处理变化文件，还是又处理了全库。
- 智谱等模型大约会产生多少费用。

### 上游可复用的内容

在 GBrain 中搜索：

```text
spend.posture
tokenmax
gated
cost estimate
delta-aware
```

优先复用：

- posture 配置类型。
- 成本门控结构。
- 按 diff 估算的算法。
- 超限提示和修复建议格式。

### PMBrain 要增加的配置

```text
spend.posture = gated
spend.posture = tokenmax
```

含义：

- `gated`：执行前展示预计消耗，需要用户确认。
- `tokenmax`：不超过用户设置的 token 上限。

可增加：

```text
spend.max_tokens
spend.max_cost
spend.currency
spend.require_confirmation
```

### 估算必须基于实际变化

只计算：

- 新增文件。
- 修改文件。
- 需要重新 embedding 的 chunk。
- 模型变化后确实需要重算的数据。

不能拿全库大小假装是本次费用。

### 用户最终能感受到的变化

执行同步或向量化前看到：

```text
预计处理 126 个文件
预计生成 1,830 个 chunk
预计消耗 620,000 tokens
预计费用：价格已配置时显示
```

价格未知时：

```text
只显示 token，明确说明当前模型价格未知
```

不能编造金额。

### 接入位置

- CLI sync。
- CLI embed backfill。
- Admin Console 同步确认框。
- Office 批量导入。
- Dream 需要大规模重算 embedding 时。

---

## 改动四：每个知识库可以自带自己的 Skill

### 当前问题

PMBrain 目前有全局 skills，但不同知识库可能需要不同规则。

例如：

- PMBrain 项目知识库，需要项目管理规则。
- 小说项目，需要人物、情节、章节规则。
- 公众号知识库，需要标题、封面和表达风格规则。

### 上游可复用内容

读取：

```text
D:\cursor-claude\gbrain
```

中与以下关键词有关的代码：

```text
brain skillpack
list_brain_skillpack
get_skill
skill source
skill manifest
```

### PMBrain 的目录设计

每个 Source 可使用：

```text
<知识库根目录>\
  .pmbrain\
    skills\
      manifest.json
      xxx.md
      yyy.md
```

兼容读取：

```text
.gbrain\skills\
```

但 PMBrain 对外以 `.pmbrain` 为主。

### Skill 优先级

```text
用户明确指定的 skill
    >
当前 Source 自带 skill
    >
PMBrain 全局 skill
    >
PMBrain 内置默认规则
```

### 用户最终能感受到的变化

某个知识库可以自己带着“如何处理这个知识库”的规则。

把 PMBrain 当底座开发小说编排工具时，不需要把所有规则写死到 PMBrain 主程序里。

### 需要接入

- Skill loader。
- Source。
- MCP。
- CLI。
- Admin Console。
- 冲突诊断。

不能复制上游后再做第二套互不相干的 Skill Runtime。

---

## 改动五：增加 Advisor，主动告诉用户 PMBrain 哪里需要处理

### 当前问题

Doctor 更像“检查是否坏了”，但普通用户不知道下一步应该做什么。

### 上游可复用内容

读取：

```text
D:\cursor-claude\gbrain\src\core\advisor\
```

如果 PMBrain 没有该目录，可以复制 Advisor 的：

- Rule 接口。
- Recommendation 数据结构。
- 规则执行器。
- 排序逻辑。
- JSON 输出结构。

具体规则需要适配 PMBrain。

### PMBrain Advisor 要检查的问题

例如：

- 数据库 migration 未完成。
- embedding 覆盖率过低。
- Source 很久没同步。
- 有未恢复的 checkpoint。
- 有大量隔离文件。
- pace mode 不适合当前数据库。
- spend posture 未配置。
- 智谱 embedding 配置缺失。
- ChatGPT Tunnel 未连接。
- OAuth metadata 异常。
- Office 文件解析失败。
- PGLite 数据目录异常。
- Git Source 未开启 durability。
- Source Skillpack 版本冲突。

### 用户最终能感受到的变化

新增：

```powershell
pmbrain advisor
pmbrain advisor --json
```

Admin Console 首页显示：

```text
当前最值得处理的 3 件事
```

每条建议包括：

- 问题是什么。
- 为什么值得处理。
- 建议命令。
- 影响哪个 Source。

Advisor 只读，不自动执行危险操作。

---

## 改动六：PMBrain 可以主动给 Agent 补充上下文

### 当前问题

现在通常是 Agent 想起来了才搜索 PMBrain。

新能力是：

```text
Agent 最近聊到了某个项目、人物或模块
    ↓
PMBrain 发现知识库中有高度相关页面
    ↓
主动返回这些页面
```

### 上游可复用内容

在 GBrain 中搜索：

```text
volunteer_context
volunteer context
watch
rolling window
context feedback
```

优先复制：

- 置信度计算。
- rolling window。
- alias/title/slug 匹配。
- 去重。
- stats 统计结构。

### PMBrain 接口

增加核心方法：

```ts
volunteerContext({
  turns,
  sourceIds,
  threshold,
  maxResults
})
```

增加 MCP 操作：

```text
volunteer_context
```

增加 CLI：

```powershell
pmbrain watch
pmbrain watch --stats
```

### 默认规则

```text
最近 4 轮对话
默认阈值 0.7
```

参考置信度：

```text
别名精确匹配：0.9
标题精确匹配：0.8
slug 后缀匹配：0.6
只有模糊语义匹配：不直接主动推送
```

### 用户最终能感受到的变化

Agent 和 PMBrain 的配合不再只是：

```text
有问题 -> 手动搜知识库
```

而是：

```text
正在聊项目 -> PMBrain 主动发现相关资料
```

第一版只提供标准 MCP/CLI 能力，不要求一次性改造所有 AI 客户端。

---

## 改动七：Git 类型的知识库可以安全自动提交和同步

### 当前问题

有些知识库是 Git 仓库，需要：

- 提交。
- push。
- 定期 pull。
- 处理 ahead/behind。
- 避免不同电脑产生分叉。

但 PMBrain 也支持普通文件夹、Office 和 Syncthing，不能强制所有 Source 使用 Git。

### 上游可复用内容

在 GBrain 中搜索：

```text
sources harden
git-remote
brain-commit-push
divergence
safe rebase
```

复用：

- push 成功确认。
- divergence 检测。
- 脏树跳过。
- 安全 rebase。
- 定时 pull 状态判断。

### PMBrain 新增命令

```powershell
pmbrain sources harden <source-id>
```

只允许 Git Source 使用。

### Windows 适配

不能只复制 `.sh` 脚本。

优先考虑：

- 用 Bun/TypeScript 实现跨平台逻辑；
- 或同时提供 `.ps1`。

禁止：

- 自动 hard reset。
- 覆盖脏工作树。
- push 失败却显示完成。
- 对普通 Source 强制 Git 初始化。

### 用户最终能感受到的变化

Git 知识库可以开启可选的“持久化保护”：

- 自动检查是否提交成功。
- 确认是否 push 成功。
- 定时安全 pull。
- 分叉时停止并提醒用户处理。

---

## 改动八：修复多 Source 读取范围和底层数据可靠性

这一部分主要是安全和稳定性，用户平时不一定直接看到。

### Federated Read Scope

对比 GBrain v0.42.46.0 相关代码，只移植查询条件。

检查：

- get_page。
- get_tags。
- get_links。
- get_backlinks。
- get_timeline。
- graph traversal。
- MCP read tools。
- Admin read APIs。

link 查询要同时检查：

- 起点页面。
- 目标页面。
- 创建该 link 的页面。

不能出现搜索限制了 Source，但 backlinks 或 timeline 又能读到范围外内容。

### JSONB 修复

检查 PMBrain 中：

```sql
$N::jsonb
```

和：

```ts
JSON.stringify(...)
```

组合使用的地方。

需要避免真实 Postgres 把 JSON 数组写成 JSON 字符串标量。

### checkpoint 修复

吸收上游：

- checkpoint 完整性。
- append-only 进度。
- 中断恢复。
- stale lock 安全处理。
- 固定 Git target revision。
- force-push 后安全恢复。

这些修改涉及 PMBrain 核心文件，只允许逐段移植，禁止覆盖。

---

# 4. 哪些代码可以直接复制

优先判断以下文件是否能直接复制：

```text
gbrain\src\core\db-pacer.ts
gbrain\src\core\pace-mode.ts
gbrain\src\core\advisor\ 下的独立框架文件
纯函数型 cooldown/backoff/watchdog 文件
纯函数型 relational intent 文件
纯配置型 spend posture 文件
```

复制后必须处理：

- import 路径。
- `gbrain` 名称。
- `GBRAIN_*` 环境变量。
- `.gbrain` 路径。
- CLI 提示。
- PMBrain config。
- PMBrain Source 和 Engine 类型。

兼容原则：

```text
PMBRAIN_* 优先
GBRAIN_* 兼容
```

---

# 5. 哪些代码绝对不能整文件复制

禁止用 GBrain 文件覆盖以下 PMBrain 文件：

```text
src/core/db.ts
src/core/postgres-engine.ts
src/core/pglite-engine.ts
src/core/engine.ts
src/core/types.ts
src/commands/sync.ts
src/commands/dream.ts
src/cli.ts
src/mcp/*
Admin Server 核心文件
Admin Console 核心页面
```

这些文件中已经包含 PMBrain 自己的：

- Office 导入。
- 国产模型。
- Admin Console。
- ChatGPT Tunnel。
- OAuth。
- Windows Desktop。
- PM schema。
- 中文配置。
- 自然语言任务控制。

正确方式：

```text
对比两边文件
    ↓
找到上游新增的函数或代码块
    ↓
只移植这一段
    ↓
保留 PMBrain 其他代码
```

---

# 6. 建立上游适配层

为了以后继续吸收 GBrain 更新，建议在 PMBrain 增加：

```text
src/upstream/
  adapters/
    config-adapter.ts
    source-adapter.ts
    engine-adapter.ts
    gateway-adapter.ts
    mcp-adapter.ts
  compatibility/
    env.ts
    paths.ts
    names.ts
```

用途：

- 统一兼容 `PMBRAIN_*` 和 `GBRAIN_*`。
- 统一兼容 `.pmbrain` 和 `.gbrain`。
- 把 GBrain 的 Source 类型转换成 PMBrain Source。
- 把上游模型成本算法接到 PMBrain gateway。
- 避免在每个复制来的文件里到处写兼容判断。

不是所有代码都必须放进 `src/upstream`，独立核心模块仍可放在 `src/core`。

---

# 7. 实际执行顺序

Codex 必须按以下顺序开发：

```text
第一步：比较本地两个仓库并建立移植审计
    ↓
第二步：db-pacer + pace-mode
    ↓
第三步：数据库连接、supervisor、cooldown、watchdog
    ↓
第四步：JSONB、checkpoint、中断恢复
    ↓
第五步：spend posture 成本控制
    ↓
第六步：Skillpack + Advisor
    ↓
第七步：Push-Based Context
    ↓
第八步：Git Source Durability
    ↓
第九步：Federated Read Scope
    ↓
第十步：Admin Console、Desktop、MCP 全量回归
```

先做稳定性，再做新功能。

---

# 8. Codex 每做一项功能的固定流程

## 8.1 先读取本地上游

例如 pacer：

```powershell
Get-Content D:\cursor-claude\gbrain\src\core\db-pacer.ts
Get-Content D:\cursor-claude\gbrain\src\core\pace-mode.ts
```

## 8.2 查找该功能的相关提交

在 GBrain 本地仓库中：

```powershell
cd D:\cursor-claude\gbrain
git log --all --oneline --grep="pacer"
git log --all --oneline --grep="advisor"
git log --all --oneline --grep="volunteer"
```

## 8.3 查看具体修改

```powershell
git show <commit> --stat
git show <commit>
```

## 8.4 分类

输出：

```text
可以直接复制的新增文件
需要 Adapter 的文件
只能移植 diff 的核心文件
可以复制的测试
```

## 8.5 修改 PMBrain

```powershell
cd D:\cursor-claude\PMBrain
```

只在 PMBrain 中写入。

## 8.6 测试

至少执行：

```powershell
bun run typecheck
bun run verify
bun test <相关测试>
```

## 8.7 独立提交

每项能力独立 commit，并注明：

```text
Upstream-Source: D:\cursor-claude\gbrain@<commit>
```

---

# 9. 上游能力来源台账

在 PMBrain 中创建：

```text
D:\cursor-claude\PMBrain\项目管理\上游能力来源台账.md
```

格式：

| PMBrain 能力 | GBrain commit | GBrain 文件 | PMBrain 文件 | 移植方式 | 后续同步办法 |
|---|---|---|---|---|---|

移植方式只能是：

```text
直接复制
复制后适配
算法复制+Adapter
核心 diff 移植
未采用
```

这样以后 GBrain 更新时，可以快速知道 PMBrain 哪些功能还能继续跟进。

---

# 10. 必须保留的回归范围

开发完成后，确认以下能力没有被冲掉：

- Admin Console。
- 中文界面。
- 自然语言任务入口。
- Office 导入。
- PDF、Excel、Word、WPS。
- 图片和音频。
- 智谱、MIMO、DeepSeek。
- PGLite。
- Postgres。
- stdio MCP。
- HTTP MCP。
- OAuth。
- ChatGPT Tunnel。
- Windows Electron。
- 非 Git Source。
- 旧 `.gbrain` 配置兼容。
- 新 `.pmbrain` 配置。

完整测试：

```powershell
cd D:\cursor-claude\PMBrain
bun install
bun run typecheck
bun run verify
bun run check:all
bun test
bun run build:admin
bun run desktop:build
```

有 Postgres 测试库时：

```powershell
bun run test:e2e
```

---

# 11. 最终交付

在 PMBrain 中创建：

```text
项目管理\上游能力移植审计.md
项目管理\上游能力来源台账.md
项目管理\上游能力融合开发报告.md
```

开发报告必须写清楚：

1. 哪些文件直接从 GBrain 复制。
2. 哪些文件复制后做了适配。
3. 哪些核心文件只移植了 diff。
4. PMBrain 原有功能如何被保留。
5. 哪些上游功能没有采用及原因。
6. 所有测试结果。
7. 已知风险。
8. 如何回滚。

---

# 12. Definition of Done

- [ ] 所有修改只发生在 `D:\cursor-claude\PMBrain`。
- [ ] `D:\cursor-claude\gbrain` 只读，未被修改。
- [ ] 没有重新下载上游仓库。
- [ ] 没有整仓 merge。
- [ ] 没有覆盖 PMBrain 核心文件。
- [ ] db-pacer 和 pace-mode 已复用。
- [ ] sync、embed、Dream 已接入 pacing。
- [ ] supervisor 可以从数据库瞬断恢复。
- [ ] 每个 Source 有独立故障冷却。
- [ ] sync 有停滞 watchdog。
- [ ] Postgres shared singleton ownership 已修复。
- [ ] JSONB 写入问题已修复。
- [ ] checkpoint 支持可靠恢复。
- [ ] spend posture 已接入。
- [ ] 成本按本次 diff 估算。
- [ ] Source 可以携带 Skillpack。
- [ ] Advisor 可以输出 PMBrain 特有建议。
- [ ] volunteer_context 可以通过 MCP 调用。
- [ ] watch 可以输出主动上下文。
- [ ] Git durability 只对 Git Source 生效。
- [ ] Federated Read Scope 已审计和修复。
- [ ] Admin Console 已集成相关能力。
- [ ] Office、国产模型、MCP、OAuth、Tunnel、Desktop 均未被破坏。
- [ ] PGLite 和 Postgres 测试通过。
- [ ] 每项能力有独立提交和上游来源记录。

本次开发的目的不是把 PMBrain 重新变回 GBrain，而是直接利用本地 GBrain 已经完成的工程能力，把它们安全融合到 PMBrain 当前产品中。
