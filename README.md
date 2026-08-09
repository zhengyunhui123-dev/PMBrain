# PMBrain — 项目管理知识大脑

PMBrain 是一个本地优先的项目与个人知识大脑。它把分散在不同 Source 中的项目文档、
会议纪要、需求、合同和笔记接入同一套检索与知识整理能力，并通过 CLI、MCP、Admin
Console 和 Windows 桌面端提供访问入口。

项目以 [GBrain](https://github.com/garrytan/gbrain) 为底层逻辑基线，在多 Source、中文
检索、国内模型、桌面端和管理交互上持续扩展。上游文档不是 PMBrain 的默认使用说明。

## 核心能力

- 多 Source 管理：按 `source_id + slug` 隔离内容，同时保留显式的共享回退规则。
- 混合检索：关键词、标题、关系、向量和可选 Reranker 共同参与召回与排序。
- Dream 周期：整理资料、抽取事实与关系、生成候选观点，并保留审批边界。
- 多入口：CLI、HTTP/MCP、Admin Console 与 Windows 桌面端复用核心能力。
- 双引擎：PGLite 适合本地单机，Postgres + pgvector 适合独立数据库部署。
- 数据保护：原始资料、Wiki、数据库内知识和已有向量不会因升级或普通测试被隐式重建。

## 快速开始

### Windows 桌面版

桌面版内置运行时、PGLite 和所需 WASM 资源，适合希望直接安装使用的 Windows 用户。
首次启动会引导选择本地 PGLite 或外部 Postgres，并沿用可识别的已有配置。

详见 [桌面版安装与首次使用](docs/desktop/安装与首次使用.md)。需要独立数据库时，再看
[Docker Postgres 首次安装](docs/desktop/首次安装使用DockerPostgres.md)。

### CLI + PGLite

```powershell
bun install -g github:zhengyunhui123-dev/PMBrain
pmbrain init --pglite
pmbrain serve --http --port 3131
```

浏览器打开 `http://127.0.0.1:3131/admin` 进入 Admin Console。PGLite 数据目录同一时间
只能由一个真实进程持有；桌面端运行时，不要再让另一个 CLI 服务打开同一目录。

### CLI + Postgres

```powershell
docker run -d `
  --name pmbrain-postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=pmbrain `
  -p 5433:5432 `
  -v pmbrain-postgres-data:/var/lib/postgresql/data `
  pgvector/pgvector:pg16

docker exec -it pmbrain-postgres psql -U postgres -d pmbrain `
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

然后在 PMBrain 配置中选择 `postgres` 引擎并填写 `database_url`，再运行 `pmbrain init`
和 `pmbrain serve --http --port 3131`。数据库卷保存用户数据，不要在升级时删除或重建。

## 导入与 Source

PMBrain 可导入 Markdown、Word、PDF、Excel、CSV 和常见图片格式。每份内容都属于一个
Source；同名 slug 在不同 Source 中彼此隔离。

```powershell
pmbrain sources add my-project --path "D:\项目文档"
pmbrain sync --source my-project
pmbrain import <文件或文件夹>
```

Source 的解析顺序、共享回退和安全边界见
[Brains and Sources](docs/architecture/brains-and-sources.md)。

## 搜索与 Dream

未配置 Embedding 时，PMBrain 仍可使用关键词、标题和关系检索；显式配置向量模型后，
才启用向量召回。普通对话模型和 Embedding 模型是两套配置，不能互相代替。

```powershell
pmbrain search "关键词" --mode conservative
pmbrain search "关键词" --mode balanced --explain
pmbrain search "关键词" --mode tokenmax
pmbrain dream --phase propose_takes --dry-run --json --max-pages 25
```

切换向量模型前，PMBrain 会校验模型和实际维度。重算仅针对派生向量，不应删除原始页面
或分块。检索流程见 [Retrieval](docs/architecture/RETRIEVAL.md)，质量验收见
[检索与 Dream 质量评测规范](docs/eval/PMBrain检索与Dream质量评测规范.md)。

## MCP 接入

HTTP MCP 适合桌面端或已经运行 Admin 服务的场景：

```json
{
  "mcpServers": {
    "pmbrain": {
      "type": "http",
      "url": "http://127.0.0.1:3131/mcp",
      "headers": {
        "Authorization": "Bearer <从 Admin Console 获取的 API Key>"
      }
    }
  }
}
```

本地 STDIO 模式：

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve"]
    }
  }
}
```

ChatGPT 的连接步骤见 [ChatGPT MCP 接入](docs/mcp/CHATGPT.md)。

## 常用命令

```powershell
pmbrain init                         # 初始化当前配置的数据库引擎
pmbrain sources list                 # 查看 Source
pmbrain sync --all                   # 同步全部 Source
pmbrain search "关键词" --explain    # 搜索并显示评分依据
pmbrain capture "要记住的内容"        # 保存笔记
pmbrain embed --stale                # 按当前配置刷新过期向量
pmbrain doctor                       # 只读诊断与健康检查入口
pmbrain serve --http --port 3131     # 启动 HTTP、MCP 和 Admin Console
pmbrain --help                       # 查看当前版本的完整命令
```

## 项目地图

```text
PMBrain/
├── admin/                  # Admin Console（React + Vite）
├── desktop/                # Electron Windows 桌面端
├── src/
│   ├── cli.ts              # CLI 入口
│   ├── commands/           # Command、HTTP 与 Admin API
│   ├── core/               # 引擎、检索、导入、Source、Dream、AI
│   └── mcp/                # MCP 分发
├── skills/                 # 项目技能与解析入口
├── docs/                   # 精选的 PMBrain 架构、安装和评测文档
├── evals/                  # 质量评估
├── test/                   # 核心测试
├── CLAUDE.md               # AI 项目地图与按任务调用链
└── AGENTS.md               # 项目工作规则与数据边界
```

AI 参与开发时先读 [AGENTS.md](AGENTS.md) 和 [CLAUDE.md](CLAUDE.md)，然后只追踪当前任务
对应的一条调用链，不需要先理解全项目，也不默认通读整个 `docs/architecture/`。

## 精选文档

- [部署拓扑](docs/architecture/topologies.md) — Desktop、PGLite、Postgres 和 MCP 的边界
- [Brains and Sources](docs/architecture/brains-and-sources.md) — Source 身份、slug 与解析规则
- [基础设施分层](docs/architecture/infra-layer.md) — UI、Command、Core 与数据库引擎的分层
- [检索架构](docs/architecture/RETRIEVAL.md) — 当前 RAG 召回与排序流程
- [数据事实来源](docs/architecture/system-of-record.md) — 原始资料、数据库知识与派生数据保护
- [桌面版安装与首次使用](docs/desktop/安装与首次使用.md)
- [Docker Postgres 首次安装](docs/desktop/首次安装使用DockerPostgres.md)
- [ChatGPT MCP 接入](docs/mcp/CHATGPT.md)
- [检索与 Dream 质量评测规范](docs/eval/PMBrain检索与Dream质量评测规范.md)
- [PMBrain 与上游 GBrain 对比](docs/eval/PMBrain与原版GBrain的检索和Dream功能对比.md) — 仅在比较或合并上游能力时阅读

## 许可证

MIT License。PMBrain 基于 [GBrain](https://github.com/garrytan/gbrain) 的底层逻辑持续开发。
