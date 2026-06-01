# 实时同步：保持索引最新

## 目标

brain 仓库中的每个 markdown 更改都会在几分钟内自动搜索，无需手动干预。

## 用户获得什么

没有它：你纠正 brain 页面中的幻觉，但向量数据库
继续提供旧文本，因为没有人运行 `gbrain sync`。过时搜索
结果侵蚀信任。Brain 变得不可靠。

有了它：编辑在几分钟内出现在搜索中。向量数据库保持最新
与 brain 仓库自动同步。你永远不必记住运行同步。

## 实现

### 先决条件：会话模式池

同步在每次导入时使用 `engine.transaction()`。如果 `DATABASE_URL` 指向
Supabase 的**事务模式**池，同步将抛出 `.begin() is not a
function` 并**静默跳过大多数页面**。这是
"同步运行但没有任何反应"的头号原因。

修复：使用**会话模式**池字符串（端口 6543；会话模式）或直接
连接（端口 5432，仅 IPv6）。通过运行 `gbrain sync` 验证并
检查 `gbrain stats` 中的页面计数是否与仓库中的同步文件计数
匹配。

### 原语

始终链接同步 + 嵌入：

```bash
gbrain sync --repo /path/to/brain && gbrain embed --stale
```

- `gbrain sync --repo <path>` — 一次性增量同步。通过
  `git diff` 检测更改，仅导入更改的内容。对于小更改集（<= 100 个文件），
  嵌入在导入期间内联生成。
- `gbrain embed --stale` — 为任何没有
  它们的块回填嵌入。大型同步（> 100 个文件）或先前 `--no-embed` 运行的安全网。
- `gbrain sync --watch --repo <path>` — 前台轮询循环，每 60 秒
  （可使用 `--interval N` 配置）。小更改集的内联嵌入。在
  5 次连续失败后退出，因此在进程管理器下运行或与
  cron 回退配对。

### 方法 1：Cron 作业（推荐）

每 5-30 分钟运行一次。适用于任何 cron 调度程序。

```bash
gbrain sync --repo /data/brain && gbrain embed --stale
```

**OpenClaw：**

```
名称：gbrain-auto-sync
计划：*/15 * * * *
提示："运行：gbrain sync --repo /data/brain && gbrain embed --stale
  记录结果。如果同步失败并出现 .begin() is not a function，
  DATABASE_URL 正在使用事务模式池。"
```

**Hermes：**

```
/cron add "*/15 * * * *" "运行 gbrain sync --repo /data/brain &&
  gbrain embed --stale。记录结果。" --name "gbrain-auto-sync"
```

### 方法 2：长寿命观察者

用于近即时同步（60 秒轮询）。在退出时自动重启的进程管理器下
运行。与 `--watch` 配对，因为它在
重复失败后退出。

```bash
gbrain sync --watch --repo /data/brain
```

### 方法 3：Git Hook / Webhook

在推送事件上触发即时同步（< 5 秒）。

- **GitHub webhook：** 设置 webhook 以调用
  `gbrain sync --repo /data/brain && gbrain embed --stale`。
  通过共享密钥验证 `X-Hub-Signature-256`。
- **Git post-receive hook：** 如果 brain 仓库在同一台机器上。

### 什么被同步

同步仅索引"可同步"的 markdown 文件。这些在设计上被排除：
- 隐藏路径（`.git/`、`.raw/` 等）
- `ops/` 目录
- 元数据文件：`README.md`、`index.md`、`schema.md`、`log.md`

### 同步是幂等的

并发运行是安全的。对同一提交的两个同步是无操作的，因为内容
哈希匹配。如果 cron 和 `--watch` 同时触发，则没有冲突。

## 棘手的地方

1. **始终链接同步 + 嵌入。** 运行 `gbrain sync` 而没有
   `gbrain embed --stale` 会使新块没有嵌入。它们存在
   在数据库中，但对向量搜索不可见。始终一起运行这两个
   命令。`&&` 确保仅当同步成功时才运行嵌入。

2. **`--watch` 轮询，它不会流。** `--watch` 标志每 60 秒
   （可配置）轮询。它不是文件系统观察者或 git hook。它在
   5 次连续失败后退出，因此它需要进程管理器（systemd、
   pm2）或 cron 回退以保持活动。不要假设它永远运行。

3. **Webhook 需要服务器运行。** 如果你使用 GitHub webhook 进行
   即时同步，则接收服务器必须正在运行并可访问。如果
   推送发生时服务器已关闭，则该同步将丢失。将 webhook
   与捕获 webhook 遗漏的任何内容的 cron 回退配对。

## 如何验证

1. **编辑文件并搜索更改。** 编辑 brain markdown 文件，
   提交并推送。等待下一个同步周期（cron 间隔或 `--watch`
   轮询）。运行 `gbrain search "<来自编辑的文本>"`。更新的内容
   应该出现在结果中。如果它返回旧内容，则同步失败。

2. **将页面计数与文件计数进行比较。** 运行 `gbrain stats` 并计数
   brain 仓库中的可同步 markdown 文件。数据库中的
   页面计数应该匹配。如果它们发散，则文件被静默跳过（可能
   是事务模式池问题）。

3. **检查嵌入块计数。** 在 `gbrain stats` 中，嵌入块
   计数应该接近总块计数。大间隙意味着
   `gbrain embed --stale` 在同步后没有运行，使块不可见
   到向量搜索。

---

*是 [GBrain Skillpack](../GBRAIN_SKILLPACK.md) 的一部分。*
