# PMBrain 部署拓扑

本文只描述 PMBrain 当前支持并实际维护的运行方式。上游 GBrain 的瘦客户端、Brain Mount、
Conductor 多实例和 Supabase 专用流程不属于 PMBrain 的默认架构，相关旧资料保存在本地备份中，
不作为 AI 或用户的默认操作依据。

## 1. Windows Desktop + PGLite

这是普通 Windows 用户的默认方式。

```text
Electron Desktop
  └─ Sidecar（PGLite 唯一所有者）
       ├─ Admin Console / HTTP API
       ├─ MCP
       └─ 本地 PGLite 数据目录
```

- Desktop 负责配置、启动、停止、更新和恢复 Sidecar。
- 同一 PGLite 数据目录只允许一个 Sidecar 打开。
- Admin、导入、Dream 和 CLI 派生任务必须经过 Sidecar 协调，不能并发再开一个 PGLite 实例。
- Desktop 打包资源位于 `desktop/`，Sidecar 构建与运行时校验位于 `desktop/scripts/`。
- Windows 安装包最终由用户执行 `bun run build:win` 生成。

核心入口：

- `desktop/src/main/sidecar-manager.ts`
- `desktop/src/main/database-runtime-manager.ts`
- `src/core/pglite-engine.ts`
- `src/core/pglite-lock.ts`

## 2. CLI / 本地服务 + PGLite

适合开发、诊断和不使用 Desktop 的单机环境。

```powershell
pmbrain init --pglite
pmbrain serve --http --port 3131
```

`pmbrain serve` 进程拥有 PGLite 数据目录。运行其他数据库命令前，要先确认它们是否通过现有
服务协调；不得删除仍由活动进程持有的锁，也不得为了排错同时启动第二个所有者。

配置默认位于 `~/.pmbrain/config.json`。旧版 `~/.gbrain`、`GBRAIN_*` 和 `gbrain`
命令只作为兼容入口存在，不应写进新的 PMBrain 使用说明。

## 3. Postgres + pgvector

适合需要独立数据库服务、较大数据量或多进程安全访问的环境。

```text
Desktop / CLI / Admin / MCP
             │
             └─ Postgres + pgvector
```

- 数据库连接由 `src/core/postgres-engine.ts` 实现。
- PGLite 与 Postgres 必须保持同一 `BrainEngine` 行为合同。
- 涉及 schema、迁移、检索、Dream 或 Source 的修改必须同时验证两个引擎。
- PMBrain 不把 Supabase 作为单独的产品架构；它只是一种可托管 Postgres 选择。

## 4. MCP 接入

本地工具优先使用 HTTP MCP 或本地 STDIO：

```text
AI 工具
  ├─ HTTP MCP → http://127.0.0.1:3131/mcp
  └─ STDIO    → pmbrain serve
```

远程 ChatGPT 使用 Secure MCP Tunnel，PMBrain 仍只监听本机地址。认证、权限和 Source
范围由 PMBrain 服务端统一判断，外层 Tunnel 不复制业务权限逻辑。

## 选择方式

| 场景 | 推荐拓扑 |
|---|---|
| Windows 普通用户 | Desktop + PGLite |
| 本地开发与诊断 | CLI 服务 + 独立测试 PGLite |
| 大数据量或服务化部署 | Postgres + pgvector |
| ChatGPT 远程读取本机知识库 | 当前服务 + Secure MCP Tunnel |

无论选择哪种拓扑，都不得隐式清空、重建或迁移用户的原始资料、知识页和已有向量。
