# 教程：将你的个人 brain 扩展为公司 brain

本教程承接[个人 brain 教程](personal-brain.md)。你已经有一个可工作的 agent（Render 上的 OpenClaw，通过 Telegram 与你对话，GBrain 作为内存，Supabase 存储嵌入）。现在你希望整个团队将它用作共享的机构内存，每个人只能看到他们被允许看到的内容。

**时间：** 在个人 brain 安装基础上再增加约 90 分钟。
**成本：** 对于 25 人的公司，持续使用每月低于 $100。

如果你还没有完成个人 brain 安装，[请先从这里开始](personal-brain.md)。当你让 agent 在 Telegram 上响应你之后再回来。本教程假设你已经完成了这些设置。

我是 Garry Tan。我构建 GBrain 是为了在 Y Combinator 运行我自己的 AI agents。经过几个月的 multi-user 功能落地（跨团队来源的并行同步、每用户 OAuth 范围、无泄漏的跨所有读取路径隔离），它终于也可以作为公司 brain 使用。如果今天我要为一家 10-50 人的公司搭建，我会运行这个配方。

---

## 第 1 部分：心智模型

### 从个人到公司，什么发生了变化

你构建的个人 brain 是单用户系统：一个 git 仓库、一个 agent、你的东西。公司 brain 是相同的架构，但有三个补充：

1. **同一 brain 内的多个来源。** 你的会议笔记是一个来源。每个队友的客户笔记本是另一个。共享的公司 wiki 是第三个。它们存在于同一数据库中，但保持独立。
2. **带有范围的每用户登录。** 每个队友获得自己的 OAuth 凭证。凭证决定他们可以读取和写入哪些来源。Alice 写入她的客户来源，读取她自己的和共享的那个。Bob 写入 internal-ops，读取他自己的和共享的那个。两者都不能看到对方的写入。
3. **每人的文件夹、cron 和 skills。** 共享 brain 有共享结构，但每个队友获得自己的子文件夹用于他们自己的工作、自己的定时任务（每周摘要、客户跟进）和自己的范围 skills。

### 这不是什么

这**不是**不同的安装。来自个人 brain 的 agent 运行时、Supabase 后端、GBrain CLI 和 AlphaClaw 工具链保持完全一样，就像你设置它们的那样。我们是在这个堆栈上添加，而不是替换它。

这也**不是** thin-client-everywhere 设置。你的个人 agent 保持原样（OpenClaw + Telegram）。每个队友添加他们自己选择的客户端（Claude Code、Cursor、Claude Desktop、他们自己的 OpenClaw 等），并将其指向 brain。

### 你获得的而一个人的 brain 没有的东西

- **共享内存。** 整个团队查询同一个 brain。Alice 在周二写的合同笔记在 Bob 周五询问该客户时显示出来，并引用回 Alice 的笔记。
- **范围隐私。** 绩效评估不会泄漏到客户查询中。法律文档不会泄漏到销售搜索中。我们在每个读取路径上进行了模糊测试，结果为零泄漏。
- **一个同步管道。** 你的 brain git 仓库（或者如果你想按团队隔离，可以是几个）供给 brain。每个人看到最新的。
- **一个操作负担。** 一台服务器要监控，而不是每个用户一台。

---

## 第 2 部分：将 brain 后端切换到多用户 Postgres

个人 brain 安装使用 Supabase 作为嵌入层，但 GBrain 运行时本身可能使用 PGLite（单机），具体取决于你采用的路径。对于公司 brain，你也需要一个真实的 Postgres 用于运行时。如果你的个人 brain 安装已经是端到端 Postgres 或 Supabase，请跳到第 3 部分。

如果你在 PGLite 上，请迁移：

```bash
gbrain migrate --to supabase
```

这会将每个页面、chunk、嵌入、链接和配置复制到你的 Supabase 项目。从 agent 主机运行，即你在个人 brain 教程中设置的那台。每 10K 页面需要几分钟。

验证：

```bash
gbrain doctor
gbrain stats
```

页面计数和 chunk 计数应该与你在 PGLite 上的相匹配。

---

## 第 3 部分：将 brain 划分为来源

个人 brain 有一个来源（称为 `default`）保存所有内容。对于公司 brain，我们需要多个。正确的 shape 取决于你的组织。以下是适用于 10-50 人公司的典型起点：

```bash
# 一个所有人读取的共享全员来源
gbrain sources add shared --path /srv/brain-repos/shared --name "共享公司 wiki"

# 一个用于销售/客户笔记的范围来源
gbrain sources add customers --path /srv/brain-repos/customers --name "客户笔记"

# 一个用于仅内部文档的范围来源（法律、HR、绩效、董事会）
gbrain sources add internal --path /srv/brain-repos/internal --name "仅内部"
```

每个 `--path` 是你已签出 git 仓库的磁盘目录。创建它们：

```bash
sudo mkdir -p /srv/brain-repos
sudo chown $USER /srv/brain-repos
cd /srv/brain-repos
git clone git@github.com:your-org/shared-wiki.git shared
git clone git@github.com:your-org/customers.git customers
git clone git@github.com:your-org/internal-docs.git internal
```

你也可以将现有的个人 brain 仓库保留为来源之一。只需选择它扮演的角色（如果它已经是整个组织的内容，可能是 `shared`）。

### 两种范围模型（选择符合你 shape 的一个）

有两种方法可以范围队友的访问。它们适合不同的部署 shapes。

**模型 A：带有 OAuth 范围的独立来源（推荐用于具有不同 AI 客户端的真正多用户）。** 本教程将引导你完成。每个队友获得自己的 OAuth 客户端，它携带 `--source` + `--federated-read` 标志。brain 在 SQL 层拒绝跨来源读取；隔离是由数据库强制执行的。每个队友可以运行他们自己的支持 MCP 的客户端（Claude Code、Cursor、他们自己的 OpenClaw 等），并且范围保持不变。

**模型 B：单一来源，基于目录的每人范围（对于 one-agent-serves-everyone 设置更简单）。** 我在生产环境中实际运行的 shape：一个名为 `default` 的单一来源，内部有 `partners/<slug>/` 约定（例如 `partners/alice-example/`、`partners/bob-example/`）。每个合作伙伴获得自己的子目录，保存他们的个人页面：`partners/alice-example/USER.md`、`partners/alice-example/concepts/`、`partners/alice-example/sources/` 等。没有 OAuth 强制的隔离；agent 本身强制"Alice 的写入进入她的 partners/ 子目录"。当你的一（你的）agent 通过 Telegram 或单一共享界面向所有人服务时，这是正确的模型。它更简单，无需每用户 OAuth，但范围仅是约定。

对于大多数公司 brain 安装（10+ 队友，每人有自己的 AI 客户端），模型 A 是正确的起点。如果你从个人 brain 教程运行 fat-agent-serves-everyone 模式，模型 B 确实更简单。你也可以混合：为明显不同的来源（客户笔记 vs 仅内部）使用独立来源，并在共享来源内使用 `partners/<slug>/` 约定用于每人工作区。

### 每个来源内的每人文件夹结构

在每个来源内，给每个队友他们自己的子文件夹。这是我运行的结

（由于篇幅限制，此处省略了部分内容）

---

## 第 14 部分：常见陷阱

### "我的队友看不到任何东西"

在主机上检查 `gbrain auth list`，并确认他们的客户端是否将 `--source` 设置为实际存在的来源。空或 null `--source` 意味着客户端回退到 `default` 来源，如果你设置了三个命名来源，它可能没有内容。

### "同步很慢，感觉卡住了"

第一次同步会嵌入每个页面，这需要时间。检查 `gbrain sources status` 的实时页面计数。如果它在攀升，你就没有卡住，你只是在嵌入。如果你的 10K 页面语料库和 ZeroEntropy 被限制，每来源并行同步看起来像三个来源同时进展，而不是一个来源快速移动。

### "我看到了我不应该看到的页面"

这不应该发生，但如果你怀疑它，以受约束的客户端身份运行 `gbrain search <query> --remote --json` 并检查每个返回结果的 `source_id` 字段。每一行都应该在客户端的 `--federated-read` 集中。如果有一行不在，请用确切的 slug 和来源 ID 提交 issue。

### "合成答案错了"

brain 层基于检索到的页面。如果检索到的页面包含错误信息，答案也会包含。差距分析注释通常会捕获这一点：如果答案说"基于日期 X 的检索页面"，而日期 X 是六个月前，brain 是在告诉你信息已过时。运行 `gbrain sync --all` 刷新并重试。

### "OAuth `/token` 端点为我的客户端返回 401"

验证客户端密钥与 register-client 时打印的相匹配。服务器仅存储 SHA-256 哈希；如果你丢失了原始密钥，你必须撤销客户端并重新注册。使用 `gbrain auth revoke-client <client_id>` 并重新运行 `register-client`。

### "Postgres 连接耗尽"

每个并行同步工作器打开自己的池。对于三个来源和每来源四个工作器，如果你将 Postgres 连接限制设置得很低，你可能会达到限制。使用 `gbrain sync --all --parallel 2 --workers 2` 减少工作器计数，或将你的 Postgres `max_connections` 提高到至少 100。Supabase 的免费层默认为 60，这很紧张。

### "我想添加第四个队友，但他们需要访问所有三个来源"

```bash
gbrain auth register-client diana-example \
  --grant-types client_credentials \
  --scopes read,write \
  --source shared \
  --federated-read shared,customers,internal
```

就是这样。随着组织的发展，添加或轮换队友。

---

## 你构建了什么

你现在拥有了来自前一个教程的个人 brain agent，以及一个位于顶部的多用户共享层：三个联邦来源保存共享、客户和仅内部内容；每个来源内的每人文件夹，因此队友的写入不会冲突；具有范围读取和写入的每人 OAuth 客户端；在每位队友自己的时间表上运行的每人 crons，具有他们自己的范围；agent 仅为正确的人运行的每人 skills。每个队友通过他们的 AI 客户端用普通英语查询 brain，并获得正确范围的合成、有来源的的答案。

接下来要做什么：

- **连接摄取**来自外部系统（Granola、Linear、Slack），使用[摄取来源契约](../skillpack-anatomy.md)。大多数公司希望他们的会议自动摄取，因此 brain 保持最新，而无需任何人键入笔记。
- **设置团队特定的仪表板**通过管理 UI。每个团队负责人可以有他们自己的 brain 健康和活动视图。
- **探索 brain 层的其余部分。** `gbrain whoknows`（找到关于某个主题专家）、`gbrain find_trajectory`（指标如何随时间变化）、`gbrain founder scorecard`（对 VC 和运营团队特别有用）、在不同人的笔记之间发现冲突的矛盾检测周期。

如果你在这个领域构建（YC 已将其标记为 [公司 brain 类别在其创业公司征集](https://www.ycombinator.com/rfs#company-brain)中），你不妨在此基础上构建。上面描述的所有内容都是开源的，MIT 许可，以及我在自己 AI agents 背后运行的生产环境。

问题、陷阱或值得分享的胜利？在 [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain/issues) 开 issue。
