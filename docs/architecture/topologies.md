# GBrain 部署拓扑

GBrain 支持三种部署形状。它们可以组合：单个用户可以在
同一台机器上混合所有三种形状，而不会冲突，因为每种形状都会解析为
"哪个 `~/.gbrain/config.json` 现在处于活动状态？"并且 `GBRAIN_HOME`
控制该选择。

本页介绍了三种拓扑、每种拓扑的适用时间以及具体的设置
配方。将本文档与 `docs/architecture/brains-and-sources.md`（其中
介绍了大脑内组织轴）配对 — 该文档是关于哪个数据库；
本文档是关于该数据库位于何处。

## 快速决策树

```
   "我正在设置 gbrain..."
        │
        ▼
  只是为了我，在一台机器上？ ── 是 ──▶ 拓扑 1（单大脑）
        │
        否
        │
        ▼
   远程机器是否会托管大脑
   而我的代理在本地运行？ ─── 是 ──▶ 拓扑 2（跨机器瘦客户端）
        │
        否
        │
        ▼
   多个 Conductor 工作树是否
   不应该共享代码索引？ ─── 是 ──▶ 拓扑 3（拆分引擎）
```

拓扑 2 和 3 堆栈：瘦客户端安装也可以托管每工作树
代码引擎，并且每工作树代码引擎也可以将其构件
大脑指向远程服务器。

## 拓扑 1 — 单大脑（今天的默认设置）

```
 ┌────────────────┐
 │   一台机器   │
 │  ┌──────────┐  │
 │  │  gbrain  │──┼──→  ~/.gbrain/  →  PGLite  或  Supabase
 │  │   CLI    │  │
 │  └──────────┘  │
 └────────────────┘
```

你得到什么：一个本地数据库（PGLite 用于小型大脑，Supabase 用于约 1000+
文件）。所有命令都直接针对它工作。`gbrain serve` 通过 MCP 将其
暴露给单个代理。

适用时间：单独使用，单台机器，一个代理，没有 Conductor 并行性。
这是默认设置；`gbrain init`（无标志）会为你提供此设置。

设置：

```
gbrain init           # 交互式 — 默认为 PGLite
gbrain init --pglite  # 显式本地
gbrain init --supabase  # 远程 Supabase（推荐用于 1000+ 文件）
```

此处没有其他特殊之处。其他两个拓扑是
"谁拥有数据库"和"代理如何与其通信"的变体。

## 拓扑 2 — 跨机器瘦客户端

```
 ┌────────────┐                    ┌──────────────────┐
 │ neuromancer│                    │    brain-host    │
 │ ┌────────┐ │ HTTP MCP / OAuth   │  ┌────────────┐  │
 │ │ Hermes │─┼───────────────────→│  │   gbrain   │──┼──→ Supabase
 │ │ agent  │ │                    │  │ serve --http│  │
 │ └────────┘ │                    │  └────────────┘  │
 │            │                    │   (带有 autopilot)│
 │  无本地  │                    │                  │
 │  gbrain DB │                    │                  │
 └────────────┘                    └──────────────────┘
```

你得到什么：一台机器（"neuromancer"）上的代理通过 HTTP MCP 和 OAuth 使用托管在
另一台机器（"brain-host"）上的大脑。
代理的机器没有本地引擎。所有查询、搜索、嵌入和
索引都发生在宿主上。

适用时间：

- 重型大脑（Supabase + autopilot）存在于一台功能强大的机器上；代理
  在其他地方只是使用它。
- 你需要跨多台机器的单一真相源。
- 启动并行本地安装会产生来源 ID 争用或
  重复工作。

瘦客户端的 `~/.gbrain/config.json` 带有 `remote_mcp` 字段
而不是本地数据库连接：

```jsonc
{
  "engine": "postgres",  // 已忽略 — 从未使用
  "remote_mcp": {
    "issuer_url": "https://brain-host.local:3001",
    "mcp_url":    "https://brain-host.local:3001/mcp",
    "oauth_client_id": "neuromancer-...",
    "oauth_client_secret": "..."  // 或设置 GBRAIN_REMOTE_CLIENT_SECRET
  }
}
```

CLI 调度保护会拒绝任何在瘦客户端安装上的数据库绑定命令（`sync`、`embed`、
`extract`、`migrate`、`apply-migrations`、`repair-jsonb`、`orphans`、
`integrity`、`serve`），并带有明确指向
远程宿主的错误。当瘦客户端安装时，`gbrain doctor` 运行专用的瘦客户端检查集
（OAuth 发现、token 往返、MCP 冒烟）。

### 设置

**步骤 1 — 在宿主上（brain-host）：**

```bash
gbrain init --supabase                         # 或 --pglite，无关紧要
gbrain serve --http --port 3001 --bind 0.0.0.0 # v0.34：显式绑定以进行远程访问
                                                # （自 v0.34 起默认为 127.0.0.1）
gbrain auth register-client neuromancer \
  --grant-types client_credentials \
  --scopes read,write,admin                    # admin 需要用于 ping/doctor
```

v0.34：来源范围的客户端（写入一个来源，跨多个来源进行联邦读取）。省略这两个标志以获得与 v0.33 兼容的超级客户端。

```bash
gbrain auth register-client neuromancer-dept \
  --grant-types client_credentials \
  --scopes read,write \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

`register-client` 命令会打印 `client_id` 和 `client_secret`。
记下两者。**范围必须包含 `admin`** — `submit_job`（由
`gbrain remote ping` 使用）和 `run_doctor`（由 `gbrain remote doctor` 使用）
都需要它。

**步骤 2 — 在瘦客户端上（neuromancer）：**

```bash
gbrain init --mcp-only \
  --issuer-url https://brain-host.local:3001 \
  --mcp-url https://brain-host.local:3001/mcp \
  --oauth-client-id <id> \
  --oauth-client-secret <secret>
```

预检冒烟运行三个探测（OAuth 发现、token 往返、
MCP 初始化）。如果任何探测失败，init 会以可操作的错误退出。成功后，`~/.gbrain/config.json` 会设置 `remote_mcp` 并且不会创建
本地数据库。

**步骤 3 — 配置代理的 MCP 客户端。**

对于 Claude Desktop / Hermes / openclaw，添加一个 MCP 服务器条目，
指向宿主的 `mcp_url`，并带有来自 `register-client` 的 bearer token。
Claude Desktop 的 `~/.config/claude/claude_desktop_config.json` 示例：

```jsonc
{
  "mcpServers": {
    "gbrain": {
      "type": "url",
      "url": "https://brain-host.local:3001/mcp",
      "headers": { "Authorization": "Bearer <client_secret>" }
    }
  }
}
```

**步骤 4 — 验证。**

```bash
gbrain doctor             # 运行瘦客户端检查（不需要本地数据库）
gbrain remote ping        # 触发宿主上的自动驾驶循环 (Tier B)
gbrain remote doctor      # 要求宿主运行其自己的 doctor (Tier B)
```

`gbrain sync` 和朋友将拒绝并带有明确的瘦客户端错误
命名 `mcp_url`。这是正确的行为 — 这些命令需要
此处不存在的本地引擎。

### 重新运行保护

在已经设置了瘦客户端配置的机器上运行 `gbrain init`（无标志）
会拒绝，除非使用 `--force`。这捕获了脚本化设置循环
摩擦，其中编排器不断尝试创建本地数据库。使用
`gbrain init --mcp-only --force` 刷新瘦客户端配置。

### 存储 OAuth 密钥

三个存储路径按优先级顺序：

1. **`GBRAIN_REMOTE_CLIENT_SECRET` 环境变量**（无头代理的首选）。
   设置后，覆盖配置文件中的任何内容。init 流程不会
   在源是环境变量时保留配置文件副本。
2. **带有 0600 权限的 `~/.gbrain/config.json`**（交互式
   设置的默认设置；镜像今天存储 Supabase 密钥的方式）。
3. macOS Keychain 集成在路线图上；不在 v1 中。

## 拓扑 3 — 拆分引擎，每工作树代码 + 远程构件

```
 ┌──────────────────────────────────────────────────────────────┐
 │                  一台机器                         │
 │                                                      │
 │  ┌─ 工作树 A ──────────────┐                       │
 │  │  GBRAIN_HOME=A/.conductor │                       │
 │  │  gbrain serve --port 3001 │── PGLite (代码 A)     │
 │  └─────────────────────────┘                       │
 │                                                      │
 │  ┌─ 工作树 B ──────────────┐                       │
 │  │  GBRAIN_HOME=B/.conductor │                       │
 │  │  gbrain serve --port 3002 │── PGLite (代码 B)     │
 │  └─────────────────────────┘                       │
 │                                                      │
 │  ┌─ 默认 ~/.gbrain ──────┐    HTTP MCP / OAuth   │
 │  │  gbrain serve --port 3000 │──────────────────────→ 远程构件
 │  │  └─────────────────────────┘                        (Supabase / brain-host)
 │                                                      │
 │  代理的 MCP 配置 (Hermes / Claude Desktop):       │
 │    mcp__gbrain_code__*       → http://localhost:3001 │
 │    mcp__gbrain_artifacts__*  → http://brain-host/mcp │
 └──────────────────────────────────────────────────────────────┘
```

你得到什么：每个 Conductor 工作树都有其自己的每工作树代码索引
（本地 PGLite，当工作树死掉时可以丢弃）。构件 (plans、
learnings、transcripts) 仍然存在于所有工作树都可以
查看并写入的共享大脑中。

适用时间：

- 一台机器上的多个 Conductor 工作树，全部触及同一个代码
  仓库。
- 你不希望每个工作树的代码导入覆盖其他人的
  `last_commit`、来源 ID 或符号表。
- 你确实希望构件 (plans、learnings、retros、transcripts) 是
  跨工作树可见的。

### 它是如何工作的

`GBRAIN_HOME` 选择哪个 `~/.gbrain` 目录处于活动状态。按工作树设置：

```bash
export GBRAIN_HOME=/path/to/worktree-A/.conductor/gbrain
gbrain init --pglite
gbrain serve --http --port 3001
```

每个工作树的 `gbrain serve` 实例绑定其自己的端口并为
其自己的数据库建立索引。多个 `gbrain serve` 进程很好地共存 — 它们是具有单独
配置和单独连接池的独立
操作系统进程。

构件大脑作为单独的 `gbrain serve` 实例运行，带有
默认 `~/.gbrain`（无 GBRAIN_HOME 覆盖）— 或远程，在这种情况下
它是拓扑 2 设置。

代理的 MCP 客户端配置列出多个服务器，每个服务器都有唯一的
别名。工具名称以 `mcp__<alias>__<tool>` 命名，因此代理
调用 `mcp__gbrain_code__search` 用于代码查找，`mcp__gbrain_artifacts__search`
用于构件查找。

### 推荐的嵌入模型

每工作树代码大脑仅索引源文件 — 没有会议笔记、
没有人员页面、没有脚本。在初始化时配置每个代码大脑以使用
Voyage 的代码调优模型，以便配置不会丢失到
以后的 `init` 覆盖：

```bash
export GBRAIN_HOME=/path/to/worktree-A/.conductor/gbrain
gbrain init --pglite \
  --embedding-model voyage:voyage-code-3 \
  --embedding-dimensions 1024
```

`voyage-code-3` 是 Voyage 的代码专用嵌入模型，具有
高于其通用 flaghips 的 head-to-head 数字，用于代码检索
([voyageai.com/blog](https://voyageai.com/blog))。对于已经初始化的
大脑，使用单命令擦除和重新初始化进行切换（保留每个
其他配置字段）：

```bash
gbrain reinit-pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
gbrain reindex --code --yes
```

（`gbrain config set embedding_model` 从 v0.37.11.0 开始被拒绝，因为
schema 列必须随配置一起调整大小。）

`gbrain reindex --code` 会在配置的
嵌入模型不是代码调优时打印建议。使用
`GBRAIN_NO_CODE_MODEL_NUDGE=1` 抑制，如果你故意选择了另一个
提供程序（单一供应商采购、合规性、没有 Voyage 密钥）。

### 关键：别名级路由是手动的

拓扑 3 在 gbrain 内部没有智能每工具路由。代理选择
哪个大脑在其选择别名时进行查询。**
错误的别名会静默地写入（或
查询）错误的大脑。** 这是故意的（显式优于
魔术），但是真实的：

- 如果代理使用代码形状的内容调用 `mcp__gbrain_artifacts__put_page`，则该页面会永远留在构件大脑中。
- 如果代理针对实际上想要构件上下文的问题调用 `mcp__gbrain_code__search`，则搜索会返回空。

缓解措施：

- 清楚地命名别名。`gbrain_code` 与 `gbrain_artifacts` 是明确的；
  `gbrain` 与 `gbrain_local` 则不是。
- 在代理的系统提示或规则中记录哪个别名去哪里。
  要明确关于"代码问题 → `gbrain_code`；其他所有内容 →
  `gbrain_artifacts`。"
- 将拓扑 3 与 `gstack` 的每工作树连接（设置每工作树
  别名名称 + 代理规则跨工作树保持一致）。

### 设置（手动；gstack 自动执行此端）

gbrain 端需要零新代码 — `GBRAIN_HOME` 和 `--port` 已经
存在。设置看起来像：

```bash
# 在端口 3000 上启动构件大脑（默认 ~/.gbrain）
gbrain serve --http --port 3000 &

# 在端口 3001 上启动每工作树代码大脑
export GBRAIN_HOME=/path/to/worktree-A/.conductor/gbrain
gbrain init --pglite
gbrain serve --http --port 3001 &
unset GBRAIN_HOME
```

然后配置代理的 MCP 配置，其中有两个条目（不同的别名、
不同的端口）。对于 Claude Desktop：

```jsonc
{
  "mcpServers": {
    "gbrain_artifacts": {
      "type": "url",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token-A>" }
    },
    "gbrain_code": {
      "type": "url",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <token-B>" }
    }
  }
}
```

gstack 端连接（每工作树主目录设置、端口分配、自动
MCP 配置生成、每工作树数据库的 gitignore）在 gstack
仓库的 setup-gbrain 技能中 — 它组合这些基元，gbrain 不
需要知道 Conductor。

## 组合拓扑

这三种形状可以组合。单台机器可以运行：

- 指向远程构件大脑的瘦客户端默认配置
  （拓扑 2）。
- 加上其自己的 `GBRAIN_HOME` 下的每工作树代码大脑（拓扑 3）。
- 每个工作树的 `gbrain serve` 实例是本地的；代理的 MCP 配置
  将它们与远程构件大脑一起列出。

`GBRAIN_HOME` 控制哪个配置文件处于活动状态以进行任何一次 CLI
调用。`gbrain serve --port` 控制服务器侦听哪个端口。
代理的 MCP 客户端选择别名，并因此选择每工具
调用的目的地。没有全局 gbrain 编排器可以同时了解所有这些信息
— 这是设计使然。

## 何时不使用这些拓扑

- **如果代理只在与其相同机器上运行大脑，请不要使用拓扑 2
  。** 本地 `gbrain` 安装 + `gbrain serve`（stdio）是
  更简单且更快。
- **如果你一次只有一个 Conductor 工作树，请不要使用拓扑 3
  。** 每工作树引擎的存在是为了防止争用；一次一个
  使用没有争用。
- **不要在同一 `GBRAIN_HOME` 的同一台机器上同时使用 `remote_mcp` 瘦客户端和本地引擎。** 当设置 `remote_mcp` 时，调度保护会拒绝数据库绑定
  命令。如果你确实想要一台机器上的两种模式，请使用 `GBRAIN_HOME`
  来分隔它们（瘦客户端一个主目录，本地引擎另一个主目录）。

## 另请参阅

- `docs/architecture/brains-and-sources.md` — 大脑内组织（brains
  vs sources 轴）。
- `docs/mcp/CLAUDE_DESKTOP.md` 和兄弟文档 — 每客户端 MCP 设置。
- `gbrain init --help` 和 `gbrain auth --help` 以获取命令级详细信息。
- [`docs/tutorials/`](../tutorials/) — 端到端演练，将这些
  拓扑组合到工作设置中（公司大脑、个人大脑、
  代理集成等）。
